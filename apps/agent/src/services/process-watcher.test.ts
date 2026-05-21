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

mock.module("../utils/exec", () => ({
  execText: mock(async (cmd: string, args: string[]) => {
    if (cmd === "pgrep" && args[0] === "-af" && args[1] === "claude") {
      return pgrepResponse.lines.join("\n");
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

// On macOS the watcher's readProcessCwd returns undefined (no /proc), so
// the cwd short-circuit (`cwd ? await resolveProject(...) : null`) never
// fires the resolver. Mock node:fs readlinkSync to return a deterministic
// fake cwd so the resolver call site is exercised on CI / mac dev too.
let fakeProcessCwd: string | null = "/tmp/fake-cwd";
function setFakeProcessCwd(value: string | null): void {
  fakeProcessCwd = value;
}
mock.module("node:fs", () => {
  const real = require("node:fs") as typeof import("node:fs");
  return {
    ...real,
    readlinkSync: (path: string, ..._args: unknown[]) => {
      if (typeof path === "string" && /^\/proc\/\d+\/cwd$/.test(path)) {
        if (fakeProcessCwd === null) throw new Error("ENOENT");
        return fakeProcessCwd;
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

const hasPg = !!process.env.POSTGRES_URL;
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
      setResolverResult(null);
      setFakeProcessCwd("/tmp/fake-cwd");
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

    // ── session-row-enrichment-v1 § 1.8: resolver enrichment ────────────
    //
    // These tests assert the call site introduced in process-watcher.ts §
    // 1.4 populates gitProvider / gitOwnerRepo / projectId on the freshly
    // inserted row when the resolver returns a non-null result, and that
    // existing null-project rows are re-enriched on subsequent polls.

    test("New PID with resolved project → gitProvider/gitOwnerRepo/projectId populated", async () => {
      setResolverResult({
        provider: "github",
        ownerRepo: "leonardoacosta/oo",
        projectId: null, // registry lookup miss is still a valid enrichment
      });
      setPgrepOutput([pgrepLine(1111, "claude")]);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.gitProvider).toBe("github");
      expect(row.gitOwnerRepo).toBe("leonardoacosta/oo");
    });

    test("New PID with resolver projectId → row.project_id populated", async () => {
      // Use a real UUID — the column is uuid and rejects bare text.
      const fakeProjectId = "00000000-0000-0000-0000-000000000111";
      setResolverResult({
        provider: "github",
        ownerRepo: "test/fixture",
        projectId: fakeProjectId,
      });
      setPgrepOutput([pgrepLine(2222, "claude")]);

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 1, closed: 0 });

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.projectId).toBe(fakeProjectId);
      expect(row.gitProvider).toBe("github");
      expect(row.gitOwnerRepo).toBe("test/fixture");
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
