/**
 * Unit tests for the process-watcher reconciliation pass.
 *
 * Validates behavior implemented in `apps/agent/src/services/process-watcher.ts`
 * per fix-agent-cc-session-tracking task 4.2:
 *   - Live PIDs with no matching row → row INSERTED, status='active',
 *     model='claude'.
 *   - Open rows whose PID has disappeared → row UPDATED, status='ended',
 *     endedAt != null.
 *   - Mixed (some alive, some dead, some new) → exactly the right diff.
 *   - Helper procs (mcp wrappers, zsh -c claude, etc.) are filtered out via
 *     `isClaudeCommand`.
 *   - Rows with `pid` IS NULL are legacy and NEVER touched by the watcher.
 *   - Repeated reconciliation is idempotent — second pass returns
 *     `{ created: 0, closed: 0 }`.
 *
 * Mocking strategy:
 *   `pgrep` output is injected via `mock.module("../utils/exec")` before the
 *   watcher module is imported. Each test pushes a fresh response onto the
 *   mock so we control exactly what the watcher "sees".
 *
 * DB strategy:
 *   Same scratch-schema pattern as `hooks.test.ts` — skip cleanly when
 *   POSTGRES_URL is unset. With PG available, each test wipes the sessions
 *   table in `beforeEach` so row-count assertions are deterministic.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";

// ── Mock subprocess exec BEFORE importing the watcher ──────────────────────

interface PgrepResponse {
  /** Lines printed by `pgrep -af claude`. Each line is `PID COMMAND…`. */
  lines: string[];
}

let pgrepResponse: PgrepResponse = { lines: [] };

function setPgrepOutput(lines: string[]): void {
  pgrepResponse = { lines };
}

// nx-ds6rq: mock tmux list-panes output. Each fixture is the raw stdout the
// watcher would see from
// `tmux list-panes -a -F '#{pane_pid}|#{pane_current_path}|#{session_name}|#{window_index}|#{pane_index}|#{pane_current_command}'`.
let tmuxPanesOutput: string = "";
function setTmuxPanesOutput(lines: string[]): void {
  tmuxPanesOutput = lines.join("\n");
}

// Map<parentPid, childPids[]> — controls `pgrep -P <pid>` responses for the
// descendant walk. Tests build a tiny ancestry tree like:
//   pane_pid 1000 -> 1001 (shell) -> 1234 (claude)
// by setting setChildMap({ 1000: [1001], 1001: [1234] }).
let childMap: Record<number, number[]> = {};
function setChildMap(map: Record<number, number[]>): void {
  childMap = map;
}

mock.module("../utils/exec", () => ({
  execText: mock(async (cmd: string, args: string[]) => {
    // pgrep -af claude — the master live-claude scan.
    if (cmd === "pgrep" && args[0] === "-af" && args[1] === "claude") {
      return pgrepResponse.lines.join("\n");
    }
    // pgrep -P <pid> — descendant walk for tmuxScan.
    if (cmd === "pgrep" && args[0] === "-P" && args.length === 2) {
      const pid = parseInt(args[1] ?? "", 10);
      const kids = childMap[pid] ?? [];
      return kids.join("\n");
    }
    // tmux list-panes -a -F <format> — pane scan.
    if (cmd === "tmux" && args[0] === "list-panes" && args[1] === "-a") {
      return tmuxPanesOutput;
    }
    // Any other invocation is unexpected — surface it loudly.
    throw new Error(`unexpected execText call in test: ${cmd} ${args.join(" ")}`);
  }),
  // execText callers in the watcher catch this to translate "no matches"
  // into an empty list — keep the shape stable.
  ExecError: class extends Error {
    constructor(
      public readonly cmd: string,
      public readonly args: string[],
      public readonly exitCode: number,
      public readonly stderr: string,
    ) {
      super(`exec failed: ${cmd}`);
    }
  },
  ExecTimeoutError: class extends Error {},
  execJson: mock(() => Promise.resolve(null)),
}));

// session-row-enrichment-v1 § 1.8: mock the git-project-resolver so each
// test can deterministically control what the watcher sees. Default
// behaviour is "no project" — individual tests override via
// `setResolverResult` below.
interface ResolverResult {
  provider: string;
  ownerRepo: string;
  projectId: string | null;
}
let resolverResult: ResolverResult | null = null;
function setResolverResult(result: ResolverResult | null): void {
  resolverResult = result;
}
mock.module("./git-project-resolver", () => ({
  resolveProject: mock(async (_cwd: string | null | undefined) => resolverResult),
  __resetCacheForTests: () => {},
}));

// nx-9jz0v: the watcher MUST NOT introspect /proc/<pid>/cwd because
// user-instance systemd cannot grant CAP_SYS_PTRACE under Yama=1. We mock
// node:fs.readlinkSync to record every call and fail loudly on /proc/PID/cwd
// reads, so any regression that re-introduces the /proc readlink path
// surfaces immediately in this suite.
interface ReadlinkCall { path: string }
const readlinkCalls: ReadlinkCall[] = [];
function clearReadlinkCalls(): void {
  readlinkCalls.length = 0;
}
mock.module("node:fs", () => {
  const real = require("node:fs") as typeof import("node:fs");
  return {
    ...real,
    readlinkSync: (path: string, ..._args: unknown[]) => {
      if (typeof path === "string") {
        readlinkCalls.push({ path });
        if (/^\/proc\/\d+\/cwd$/.test(path)) {
          throw new Error(
            `nx-9jz0v regression: watcher attempted readlinkSync(${path}) — ` +
              `/proc cwd reads are banned (CAP_SYS_PTRACE inert under user-instance systemd)`,
          );
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readlinkSync as any)(path, ..._args);
    },
  };
});

// Now safe to import the module under test + DB plumbing.
import { reconcileOnce, __testing } from "./process-watcher";
import { createDb, sessions, eq } from "@nexus/db";
import type { Db } from "@nexus/db";

type Sql = ReturnType<typeof createDb>["client"];

import { hasLivePg as hasPg } from "../testing/live-pg";
if (!hasPg) {
  // eslint-disable-next-line no-console
  console.log(
    "[process-watcher.test] POSTGRES_URL not set — skipping watcher integration tests",
  );
}

const SCHEMA = `nx_pw_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" uuid,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp,
    "pid" integer,
    "cwd" text,
    "branch" text,
    "session_type" text,
    "model" text,
    "rate_limit_utilization" real,
    "total_cost_usd" double precision,
    "rate_limit_reset_at" timestamp,
    "idle_since" timestamp,
    "cc_session_id" text,
    "tmux_session" text,
    "tmux_target" text,
    "spec" text,
    "credential_id" text,
    "credential_fingerprint" text,
    "git_provider" text,
    "git_owner_repo" text,
    "agent_state" text,
    "parent_session_id" text,
    "child_role" text
  );
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function pgrepLine(pid: number, cmd: string): string {
  return `${pid} ${cmd}`;
}

async function insertRow(
  db: Db,
  row: {
    id: string;
    pid: number | null;
    status?: string;
    endedAt?: Date | null;
    model?: string | null;
    cwd?: string | null;
    tmuxTarget?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await db.insert(sessions).values({
    id: row.id,
    machine: "local",
    status: row.status ?? "active",
    startedAt: now,
    lastActivity: now,
    endedAt: row.endedAt ?? null,
    pid: row.pid,
    cwd: row.cwd ?? null,
    branch: null,
    sessionType: "managed",
    model: row.model ?? "claude",
    tmuxTarget: row.tmuxTarget ?? null,
    rateLimitUtilization: null,
    totalCostUsd: null,
    rateLimitResetAt: null,
    idleSince: null,
    projectId: null,
    ccSessionId: null,
    tmuxSession: null,
    spec: null,
    credentialId: null,
    credentialFingerprint: null,
  });
}

// ── Pure-helper tests (no DB) ──────────────────────────────────────────────

describe("isClaudeCommand — helper-proc filter", () => {
  const { isClaudeCommand } = __testing;

  test("accepts bare `claude`", () => {
    expect(isClaudeCommand("claude")).toBe(true);
  });

  test("accepts `claude --foo` with flags", () => {
    expect(isClaudeCommand("claude --resume")).toBe(true);
  });

  test("accepts `/usr/local/bin/claude --foo`", () => {
    expect(isClaudeCommand("/usr/local/bin/claude --resume")).toBe(true);
  });

  test("rejects helper procs that contain 'claude' but are not the binary", () => {
    expect(isClaudeCommand("node /Users/leo/.npm/claude-context-mcp/index.js")).toBe(false);
    expect(isClaudeCommand("zsh -c claude")).toBe(false);
    expect(isClaudeCommand("npm exec claude-something")).toBe(false);
    expect(isClaudeCommand("python claude-helper.py")).toBe(false);
  });

  test("rejects empty / whitespace-only commands", () => {
    expect(isClaudeCommand("")).toBe(false);
    expect(isClaudeCommand("   ")).toBe(false);
  });
});

// ── Integration tests (need scratch PG schema) ─────────────────────────────

describe.skipIf(!hasPg)(
  "reconcileOnce — process-watcher diff (requires live PG)",
  () => {
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;
      await adminClient.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
      await adminClient.unsafe(`SET search_path TO "${SCHEMA}", public`);
      await adminClient.unsafe(DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;
    });

    afterAll(async () => {
      try {
        await scopedClient.end({ timeout: 5 });
      } finally {
        try {
          await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        } finally {
          await adminClient.end({ timeout: 5 });
        }
      }
    });

    beforeEach(async () => {
      await scopedClient.unsafe(`DELETE FROM "${SCHEMA}"."sessions"`);
      setPgrepOutput([]);
      setTmuxPanesOutput([]);
      setChildMap({});
      setResolverResult(null);
      clearReadlinkCalls();
    });

    test("New PID → row created with status='active' and model='claude'", async () => {
      setPgrepOutput([pgrepLine(1234, "claude --foo"), pgrepLine(5678, "claude")]);

      const result = await reconcileOnce(db);
      expect(result.created).toBe(2);
      expect(result.closed).toBe(0);

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(2);
      const pids = rows.map((r) => r.pid).sort();
      expect(pids).toEqual([1234, 5678]);
      for (const row of rows) {
        expect(row.status).toBe("active");
        expect(row.model).toBe("claude");
        expect(row.endedAt).toBeNull();
      }
    });

    test("Dead PID → row closed with status='ended' and endedAt set", async () => {
      await insertRow(db, { id: "row-dead", pid: 9999, status: "active" });
      setPgrepOutput([]); // No live claude procs.

      const result = await reconcileOnce(db);
      expect(result.created).toBe(0);
      expect(result.closed).toBe(1);

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-dead"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("ended");
      expect(rows[0]!.endedAt).not.toBeNull();
    });

    test("Mixed: alive row untouched, dead row closed, new pid created", async () => {
      await insertRow(db, { id: "row-alive", pid: 100, status: "active" });
      await insertRow(db, { id: "row-dead", pid: 200, status: "active" });

      setPgrepOutput([pgrepLine(100, "claude"), pgrepLine(300, "claude --new")]);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 1 });

      const alive = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-alive"));
      expect(alive[0]!.status).toBe("active");
      expect(alive[0]!.endedAt).toBeNull();

      const dead = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-dead"));
      expect(dead[0]!.status).toBe("ended");
      expect(dead[0]!.endedAt).not.toBeNull();

      const allRows = await db.select().from(sessions);
      const created = allRows.find((r) => r.pid === 300);
      expect(created).toBeDefined();
      expect(created!.status).toBe("active");
      expect(created!.model).toBe("claude");
    });

    test("Helper procs are filtered — only real claude binaries are tracked", async () => {
      setPgrepOutput([
        pgrepLine(100, "claude --foo"),
        pgrepLine(101, "node /Users/leo/.npm/claude-context-mcp/index.js"),
        pgrepLine(102, "zsh -c claude"),
      ]);

      const result = await reconcileOnce(db);
      expect(result.created).toBe(1);
      expect(result.closed).toBe(0);

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.pid).toBe(100);
    });

    test("Rows without pid are legacy — watcher never touches them", async () => {
      // Legacy hook-driven row with no pid.
      await insertRow(db, { id: "row-legacy", pid: null, status: "active" });
      setPgrepOutput([]);

      const result = await reconcileOnce(db);
      // Watcher must NOT close it — no pid to compare against.
      expect(result.closed).toBe(0);
      expect(result.created).toBe(0);

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-legacy"));
      expect(rows[0]!.status).toBe("active");
      expect(rows[0]!.endedAt).toBeNull();
    });

    test("Live managed PID → last_activity refreshed to now, status/endedAt unchanged", async () => {
      // Seed an open, active row whose last_activity is ~10 minutes stale —
      // the exact failure mode: a long-running session between CC hook events.
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      await db.insert(sessions).values({
        id: "row-stale-live",
        machine: "local",
        status: "active",
        startedAt: stale,
        lastActivity: stale,
        endedAt: null,
        pid: 7777,
        cwd: null,
        branch: null,
        sessionType: "managed",
        model: "claude",
        tmuxTarget: null,
        rateLimitUtilization: null,
        totalCostUsd: null,
        rateLimitResetAt: null,
        idleSince: null,
        projectId: null,
        ccSessionId: null,
        tmuxSession: null,
        spec: null,
        credentialId: null,
        credentialFingerprint: null,
      });

      // Same PID is reported alive by pgrep.
      setPgrepOutput([pgrepLine(7777, "claude --resume")]);

      const before = Date.now();
      const result = await reconcileOnce(db);
      // No new rows, nothing closed — only a heartbeat refresh.
      expect(result).toEqual({ created: 0, closed: 0 });

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-stale-live"));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // last_activity must have advanced to ~now (well past the stale value).
      const lastActivityMs = new Date(row.lastActivity).getTime();
      expect(lastActivityMs).toBeGreaterThan(stale.getTime());
      expect(Math.abs(lastActivityMs - before)).toBeLessThan(10_000);

      // The row is otherwise untouched.
      expect(row.status).toBe("active");
      expect(row.endedAt).toBeNull();
    });

    test("Idempotent — second pass with same pgrep output returns {0,0}", async () => {
      setPgrepOutput([pgrepLine(4242, "claude")]);

      const first = await reconcileOnce(db);
      expect(first).toEqual({ created: 1, closed: 0 });

      // Same pgrep output — the row from pass one is now known.
      const second = await reconcileOnce(db);
      expect(second).toEqual({ created: 0, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.pid).toBe(4242);
    });

    // ── nx-9jz0v: cwd is hook-authoritative; watcher does NOT introspect
    // /proc/<pid>/cwd because user-instance systemd cannot grant
    // CAP_SYS_PTRACE under Yama=1. These tests pin that behaviour:
    //
    //   - New PIDs inserted by the watcher get cwd="" and null git fields
    //     (the resolver is NEVER called on insert — there's no cwd to
    //     resolve from).
    //   - readlinkSync is never invoked against /proc/<pid>/cwd (the mock
    //     above throws on any such call, surfacing regressions loudly).
    //   - Existing rows whose cwd was populated by a hook DO get
    //     re-enriched on the next poll via the alive-row resolver loop.

    test("New PID insert leaves cwd='' and git fields null (no /proc readlink)", async () => {
      setResolverResult({
        provider: "github",
        ownerRepo: "leonardoacosta/oo",
        projectId: "00000000-0000-0000-0000-000000000111",
      });
      setPgrepOutput([pgrepLine(1111, "claude")]);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // cwd is empty until the hook arrives (wire-shape: empty string,
      // not null — preserves existing client behaviour).
      expect(row.cwd ?? "").toBe("");
      // Resolver was not called on insert (no cwd to resolve from), so
      // git fields stay null even though the mock would return a hit.
      expect(row.gitProvider).toBeNull();
      expect(row.gitOwnerRepo).toBeNull();
      expect(row.projectId).toBeNull();

      // Binding evidence: zero /proc/<pid>/cwd readlinks were issued.
      const procReads = readlinkCalls.filter((c) => /^\/proc\/\d+\/cwd$/.test(c.path));
      expect(procReads).toEqual([]);
    });

    test("New PID with no resolver result → fields stay null (fail-soft)", async () => {
      setResolverResult(null);
      setPgrepOutput([pgrepLine(3333, "claude")]);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.gitProvider).toBeNull();
      expect(row.gitOwnerRepo).toBeNull();
      expect(row.projectId).toBeNull();
      // No /proc readlinks either.
      const procReads = readlinkCalls.filter((c) => /^\/proc\/\d+\/cwd$/.test(c.path));
      expect(procReads).toEqual([]);
    });

    // ── nx-ds6rq: tmux-derived cwd + tmuxTarget tests ─────────────────────
    //
    // When a tmux pane runs `claude` and the pid is descendable from the
    // pane's pane_pid, the watcher pulls cwd + tmuxTarget straight from
    // tmux and fires resolveProject inline. This bypasses the Yama-blocked
    // /proc/PID/cwd readlink path entirely.

    test("New PID matched to tmux pane → row gets cwd + tmuxTarget + git fields populated", async () => {
      // Live claude pid 1234 is a grandchild of pane_pid 1000:
      //   pane_pid 1000 (zsh) -> 1001 (bash wrapper) -> 1234 (claude)
      setPgrepOutput([pgrepLine(1234, "claude")]);
      setTmuxPanesOutput([
        "1000|/home/nyaptor/dev/ws|0|1|1|claude",
      ]);
      setChildMap({ 1000: [1001], 1001: [1234] });
      setResolverResult({
        provider: "github",
        ownerRepo: "leonardoacosta/ws",
        projectId: "11111111-2222-3333-4444-555555555555",
      });

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.pid).toBe(1234);
      expect(row.cwd).toBe("/home/nyaptor/dev/ws");
      expect(row.tmuxTarget).toBe("0:1.1");
      expect(row.gitProvider).toBe("github");
      expect(row.gitOwnerRepo).toBe("leonardoacosta/ws");
      expect(row.projectId).toBe("11111111-2222-3333-4444-555555555555");
      // No /proc/PID/cwd reads.
      const procReads = readlinkCalls.filter((c) =>
        /^\/proc\/\d+\/cwd$/.test(c.path),
      );
      expect(procReads).toEqual([]);
    });

    test("Pid is the pane shell directly → row gets cwd + tmuxTarget (no descendant hop)", async () => {
      // Rare but possible: tmux's pane_pid IS the claude process (no
      // intermediate shell). The BFS short-circuits when rootPid is itself
      // in the live set.
      setPgrepOutput([pgrepLine(4025347, "claude")]);
      setTmuxPanesOutput([
        "4025347|/home/nyaptor/dev/oo|0|3|1|claude",
      ]);
      // No child map needed — pane_pid IS the claude pid.
      setResolverResult(null);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.cwd).toBe("/home/nyaptor/dev/oo");
      expect(row.tmuxTarget).toBe("0:3.1");
    });

    test("Multiple panes scanned — each claude pid mapped to its own pane", async () => {
      setPgrepOutput([
        pgrepLine(4025347, "claude"),
        pgrepLine(1616637, "claude"),
      ]);
      setTmuxPanesOutput([
        "4025347|/home/nyaptor/dev/ws|0|1|1|claude",
        "1616637|/home/nyaptor/dev/oo|0|3|1|claude",
      ]);
      setResolverResult(null);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 2, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(2);
      const byPid = new Map(rows.map((r) => [r.pid, r]));
      expect(byPid.get(4025347)!.cwd).toBe("/home/nyaptor/dev/ws");
      expect(byPid.get(4025347)!.tmuxTarget).toBe("0:1.1");
      expect(byPid.get(1616637)!.cwd).toBe("/home/nyaptor/dev/oo");
      expect(byPid.get(1616637)!.tmuxTarget).toBe("0:3.1");
    });

    test("Panes whose foreground command is not claude are ignored", async () => {
      // Three panes; only the third is running claude.
      setPgrepOutput([pgrepLine(5000, "claude")]);
      setTmuxPanesOutput([
        "1000|/home/nyaptor/dev/a|0|1|1|vim",
        "2000|/home/nyaptor/dev/b|0|2|1|bash",
        "3000|/home/nyaptor/dev/c|0|3|1|claude",
      ]);
      setChildMap({ 3000: [5000] });
      setResolverResult(null);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.cwd).toBe("/home/nyaptor/dev/c");
      expect(rows[0]!.tmuxTarget).toBe("0:3.1");
    });

    test("tmux unavailable → watcher falls back to PID-only detection", async () => {
      // No tmux output set; tmuxPanesOutput defaults to "" which parses to
      // an empty pane list. The fail-soft path applies — pid is inserted
      // with cwd="" and tmuxTarget=null.
      setPgrepOutput([pgrepLine(7777, "claude")]);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.cwd ?? "").toBe("");
      expect(row.tmuxTarget).toBeNull();
    });

    test("Alive row missing cwd gets tmux-derived cwd + tmuxTarget backfilled", async () => {
      // Pre-seed a row that was inserted before tmuxScan landed: pid known,
      // cwd/tmuxTarget empty.
      await db.insert(sessions).values({
        id: "row-backfill",
        machine: "local",
        status: "active",
        startedAt: new Date(),
        lastActivity: new Date(),
        endedAt: null,
        pid: 8888,
        cwd: "",
        branch: null,
        sessionType: "managed",
        model: "claude",
        tmuxTarget: null,
        rateLimitUtilization: null,
        totalCostUsd: null,
        rateLimitResetAt: null,
        idleSince: null,
        projectId: null,
        ccSessionId: null,
        tmuxSession: null,
        spec: null,
        credentialId: null,
        credentialFingerprint: null,
        gitProvider: null,
        gitOwnerRepo: null,
      });

      setPgrepOutput([pgrepLine(8888, "claude --resume")]);
      setTmuxPanesOutput([
        "8000|/home/nyaptor/dev/ws|0|2|1|claude",
      ]);
      setChildMap({ 8000: [8888] });
      setResolverResult({
        provider: "github",
        ownerRepo: "leonardoacosta/ws",
        projectId: null,
      });

      const result = await reconcileOnce(db);
      // No new rows, none closed — backfill + resolver only.
      expect(result).toEqual({ created: 0, closed: 0 });

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-backfill"));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.cwd).toBe("/home/nyaptor/dev/ws");
      expect(row.tmuxTarget).toBe("0:2.1");
      expect(row.gitProvider).toBe("github");
      expect(row.gitOwnerRepo).toBe("leonardoacosta/ws");
    });

    // ── nx-tmuxdrift: stale-tmuxTarget drift repair ───────────────────────
    //
    // tmuxTarget is ephemeral. When a user closes a tmux window, tmux
    // renumbers the remaining windows, so a live claude pid (stable
    // identity) moves to a different pane. The watcher recorded the OLD
    // `<session>:<window>.<pane>` target once at discovery and only
    // re-filled it when blank — so the stored target went stale, pointed at
    // a dead pane, and PTY attach 404'd ("session not found"). These tests
    // pin the drift-repair: whenever the live tmux scan differs from the
    // stored target, the row is refreshed to the current pane address.

    test("Stale tmuxTarget is refreshed when live pid moves panes (window renumber)", async () => {
      // Reproduces the verified homelab failure: pid lives at pane 0:2.1 now,
      // but the row was recorded as 0:3.1 before window 3 was closed.
      await db.insert(sessions).values({
        id: "row-tmux-drift",
        machine: "local",
        status: "active",
        startedAt: new Date(),
        lastActivity: new Date(),
        endedAt: null,
        pid: 364754,
        // cwd is already good — only the tmuxTarget should change.
        cwd: "/home/nyaptor/dev/oo",
        branch: null,
        sessionType: "managed",
        model: "claude",
        // STALE: window 3 was renumbered away when the user closed a window.
        tmuxTarget: "0:3.1",
        rateLimitUtilization: null,
        totalCostUsd: null,
        rateLimitResetAt: null,
        idleSince: null,
        projectId: null,
        ccSessionId: null,
        tmuxSession: null,
        spec: null,
        credentialId: null,
        credentialFingerprint: null,
        gitProvider: "github",
        gitOwnerRepo: "leonardoacosta/oo",
      });

      // Live scan: pid 364754 is now a child of pane_shell 773984, whose
      // pane is window 2 (0:2.1) — window 3 no longer exists.
      setPgrepOutput([pgrepLine(364754, "claude --resume")]);
      setTmuxPanesOutput([
        "773984|/home/nyaptor/dev/oo|0|2|1|claude",
      ]);
      setChildMap({ 773984: [364754] });
      setResolverResult(null);

      const result = await reconcileOnce(db);
      // No new rows, none closed — drift-repair only.
      expect(result).toEqual({ created: 0, closed: 0 });

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-tmux-drift"));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // Drift repaired: target now points at the LIVE pane.
      expect(row.tmuxTarget).toBe("0:2.1");
      // cwd was already good and the pane cwd matches — preserved.
      expect(row.cwd).toBe("/home/nyaptor/dev/oo");
    });

    test("Matching tmuxTarget is preserved (no needless rewrite) when live scan agrees", async () => {
      // The stored target already equals the live pane address — the row's
      // values must be preserved exactly (drift-repair must not fire on a
      // row that's already correct).
      await db.insert(sessions).values({
        id: "row-tmux-stable",
        machine: "local",
        status: "active",
        startedAt: new Date(),
        lastActivity: new Date(),
        endedAt: null,
        pid: 555000,
        cwd: "/home/nyaptor/dev/ws",
        branch: null,
        sessionType: "managed",
        model: "claude",
        // Already correct — matches the live scan below.
        tmuxTarget: "0:1.1",
        rateLimitUtilization: null,
        totalCostUsd: null,
        rateLimitResetAt: null,
        idleSince: null,
        projectId: null,
        ccSessionId: null,
        tmuxSession: null,
        spec: null,
        credentialId: null,
        credentialFingerprint: null,
        gitProvider: "github",
        gitOwnerRepo: "leonardoacosta/ws",
      });

      setPgrepOutput([pgrepLine(555000, "claude")]);
      setTmuxPanesOutput([
        "554000|/home/nyaptor/dev/ws|0|1|1|claude",
      ]);
      setChildMap({ 554000: [555000] });
      setResolverResult(null);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 0, closed: 0 });

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-tmux-stable"));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // Value preserved — already-correct target is left intact.
      expect(row.tmuxTarget).toBe("0:1.1");
      expect(row.cwd).toBe("/home/nyaptor/dev/ws");
    });

    test("Existing null-project row gets re-enriched on next poll", async () => {
      // Seed an active row with null git fields. The resolver wasn't
      // available the first time around — now it is.
      await db.insert(sessions).values({
        id: "row-needs-enrich",
        machine: "local",
        status: "active",
        startedAt: new Date(),
        lastActivity: new Date(),
        endedAt: null,
        pid: 4444,
        cwd: "/home/test/repo",
        branch: null,
        sessionType: "managed",
        model: "claude",
        tmuxTarget: null,
        rateLimitUtilization: null,
        totalCostUsd: null,
        rateLimitResetAt: null,
        idleSince: null,
        projectId: null,
        ccSessionId: null,
        tmuxSession: null,
        spec: null,
        credentialId: null,
        credentialFingerprint: null,
        gitProvider: null,
        gitOwnerRepo: null,
      });

      // Resolver now returns a project for that cwd.
      setResolverResult({
        provider: "github",
        ownerRepo: "leonardoacosta/oo",
        projectId: null,
      });
      // Same PID is reported alive — heartbeat path, NOT new-row path.
      setPgrepOutput([pgrepLine(4444, "claude --resume")]);

      const result = await reconcileOnce(db);
      // No new rows, none closed.
      expect(result).toEqual({ created: 0, closed: 0 });

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-needs-enrich"));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.gitProvider).toBe("github");
      expect(row.gitOwnerRepo).toBe("leonardoacosta/oo");
    });
  },
);
