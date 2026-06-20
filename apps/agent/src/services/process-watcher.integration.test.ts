/**
 * Integration test: process-watcher against real OS processes + real tmux.
 *
 * Per fix-agent-cc-session-tracking task 4.3 — exercise the watcher against
 * actually-spawned subprocesses to prove it closes session rows when the
 * tracked PID dies for real (not just because we deleted a fixture row).
 *
 * Two flows:
 *   (a) `handleSessionStart(request, db)` → verify the row carries non-null
 *       `pid`, non-empty `tmuxTarget`, non-empty `cwd`. Requires real tmux.
 *   (b) Spawn a `sleep 60` child, insert a session row with that PID, stub
 *       `pgrep` so the watcher initially sees the PID as a "claude" process,
 *       confirm reconcileOnce leaves it alive, kill the child, flip pgrep
 *       to empty, confirm reconcileOnce now marks the row ended.
 *
 * Skips cleanly:
 *   - tmux not on PATH → tmux-dependent flow only.
 *   - POSTGRES_URL unset → entire suite (DB writes required).
 *
 * Mocking strategy:
 *   Only `pgrep` is intercepted. tmux, which, list-windows, send-keys all
 *   route through a private real-subprocess implementation (`runReal`) so
 *   the mock module body doesn't need to dynamic-import `../utils/exec`
 *   (which is itself the mocked specifier — chicken-and-egg).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";

// ── Real-subprocess passthrough (independent of ../utils/exec mock) ────────

class _ExecError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`Command failed: ${cmd} ${args.join(" ")} (exit ${exitCode}) — ${stderr}`);
    this.name = "ExecError";
  }
}

/** Minimal real `execText` re-implementation for the test's tmux passthroughs. */
async function runReal(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new _ExecError(cmd, args, exitCode, stderr);
  }
  return stdout;
}

// ── Mock subprocess exec BEFORE importing the watcher ──────────────────────

let pgrepStubLines: string[] = [];
function setPgrepStub(lines: string[]): void {
  pgrepStubLines = lines;
}

mock.module("../utils/exec", () => ({
  execText: mock(async (cmd: string, args: string[]) => {
    // Intercept pgrep — return our stubbed lines.
    if (cmd === "pgrep" && args[0] === "-af" && args[1] === "claude") {
      return pgrepStubLines.join("\n");
    }
    // Everything else (tmux, which) goes through a real subprocess.
    return runReal(cmd, args);
  }),
  execJson: mock(async (cmd: string, args: string[]) => {
    const out = await runReal(cmd, args);
    return JSON.parse(out);
  }),
  ExecError: _ExecError,
  ExecTimeoutError: class extends Error {},
}));

// ── Imports (after the mock registration) ──────────────────────────────────

import { reconcileOnce } from "./process-watcher";
import { handleSessionStart } from "../routes/sessions";
import { processHookEvent } from "./process-hook-event";
import { backfillSessionCwd } from "../db/sessions";
import type { SessionManager } from "../session-manager";
import { sweepTmuxWindowsByPrefix } from "../testing/tmux-cleanup";
import { createDb, sessions, eq } from "@nexus/db";
import type { Db } from "@nexus/db";

/**
 * Window-name prefix for every tmux window this suite spawns via
 * `/session/start` (`buildStartRequest("nexus-int-test", …)` → tmux window
 * `nexus-int-test-<Date.now()>`). The failure-safe sweep (beforeAll orphan
 * sweep + afterEach + afterAll) targets exactly this prefix so a killed/crashed
 * run can never leak windows into the user's live tmux.
 */
const INT_TEST_WINDOW_PREFIX = "nexus-int-test-";

type Sql = ReturnType<typeof createDb>["client"];

// ── Environment probe ──────────────────────────────────────────────────────

const TMUX_AVAILABLE = Bun.which("tmux") !== null;
import { hasLivePg as hasPg } from "../testing/live-pg";

if (!TMUX_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.log(
    "[process-watcher.integration.test] tmux not found on PATH — tmux flow will skip",
  );
}
if (!hasPg) {
  // eslint-disable-next-line no-console
  console.log(
    "[process-watcher.integration.test] POSTGRES_URL not set — skipping watcher integration",
  );
}

const SCHEMA = `nx_pw_int_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Mirrors packages/db/src/schema/sessions.ts + processWatcherState.ts. Keep in
// sync with the production schema — reconcileOnce writes a process_watcher_state
// row every tick, and the session_start hook path writes the git-origin +
// sub-agent-tree columns.
const DDL = `
  CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" uuid,
    "machine" text NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "started_at" timestamp NOT NULL,
    "last_activity" timestamp NOT NULL,
    "ended_at" timestamp,
    "stop_reason" text,
    "error_details" text,
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
  CREATE TABLE "process_watcher_state" (
    "id" serial PRIMARY KEY NOT NULL,
    "observed_at" timestamp DEFAULT now() NOT NULL,
    "live_pid_count" integer NOT NULL,
    "tick_duration_ms" integer NOT NULL,
    "error_text" text
  );
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function buildStartRequest(project: string, path: string): Request {
  return new Request("http://localhost:7400/session/start", {
    method: "POST",
    body: JSON.stringify({ project, path }),
    headers: { "Content-Type": "application/json" },
  });
}

interface SpawnedChild {
  child: ChildProcess;
  pid: number;
}

function spawnSleep(seconds: number): SpawnedChild {
  const child = spawn("sleep", [String(seconds)], { detached: false });
  if (!child.pid) {
    throw new Error("failed to spawn sleep");
  }
  return { child, pid: child.pid };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    // killed is set sync on .kill(); we still want to observe the exit
    // event to be sure the OS reaped it.
  }
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasPg)(
  "process-watcher integration — real spawn + real tmux (requires PG)",
  () => {
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;

    beforeAll(async () => {
      // Orphan sweep: self-heal any nexus-int-test-* windows leaked by a prior
      // killed/crashed run before we start spawning fresh ones. Name-match +
      // active-guard; kills by stable window id, never by index.
      sweepTmuxWindowsByPrefix(INT_TEST_WINDOW_PREFIX);

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
      // Belt-and-suspenders final sweep: kill any nexus-int-test-* window the
      // suite created (same name-match + active-guard as the orphan sweep).
      sweepTmuxWindowsByPrefix(INT_TEST_WINDOW_PREFIX);
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
      setPgrepStub([]);
    });

    afterEach(() => {
      // Per-test sweep: kill the window(s) the just-finished test created as
      // soon as it ends, so a mid-suite crash leaks at most one window (and the
      // next run's beforeAll orphan sweep would reclaim it anyway).
      sweepTmuxWindowsByPrefix(INT_TEST_WINDOW_PREFIX);
    });

    // ── Flow (b): real spawn → watcher closes dead PID ─────────────────

    test("reconcileOnce closes a row when its tracked PID actually dies", async () => {
      const spawned = spawnSleep(60);
      const pid = spawned.pid;

      try {
        // Insert a row that the watcher will manage, mimicking what
        // handleSessionStart / a session_start hook would have produced.
        const now = new Date();
        await db.insert(sessions).values({
          id: "int-row-1",
          machine: "local",
          status: "active",
          startedAt: now,
          lastActivity: now,
          pid,
          cwd: "/tmp",
          model: "claude",
          sessionType: "managed",
          tmuxTarget: null,
          branch: null,
          endedAt: null,
          ccSessionId: null,
          projectId: null,
          tmuxSession: null,
          spec: null,
          credentialId: null,
          credentialFingerprint: null,
          rateLimitUtilization: null,
          totalCostUsd: null,
          rateLimitResetAt: null,
          idleSince: null,
        });

        // Stage 1: pgrep stub claims this PID is a `claude` proc — the
        // watcher should leave the row alone.
        setPgrepStub([`${pid} claude --integration-test`]);
        const aliveResult = await reconcileOnce(db);
        expect(aliveResult.closed).toBe(0);
        // No new row should be created since the pid is already managed.
        expect(aliveResult.created).toBe(0);

        const stillActive = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, "int-row-1"));
        expect(stillActive[0]!.status).toBe("active");
        expect(stillActive[0]!.endedAt).toBeNull();

        // Stage 2: kill the child and flip pgrep stub to empty. The watcher
        // now sees the PID as gone and MUST close the row.
        spawned.child.kill("SIGTERM");
        await waitForExit(spawned.child);
        // Brief settle so the OS has fully reaped the PID.
        await Bun.sleep(50);

        setPgrepStub([]);
        const deadResult = await reconcileOnce(db);
        expect(deadResult.closed).toBe(1);

        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, "int-row-1"));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("ended");
        expect(rows[0]!.endedAt).not.toBeNull();
      } finally {
        // Belt-and-braces: make sure the child is gone even if an assertion
        // failed before stage 2.
        if (spawned.child.exitCode === null) {
          spawned.child.kill("SIGKILL");
        }
      }
    });

    // ── Flow (a): handleSessionStart populates pid/tmuxTarget/cwd ──────

    test.skipIf(!TMUX_AVAILABLE)(
      "handleSessionStart populates pid, tmuxTarget, cwd on the new row",
      async () => {
        // We need an existing directory for the `-c <path>` arg to succeed.
        const cwd = process.cwd();
        const req = buildStartRequest("nexus-int-test", cwd);

        const res = await handleSessionStart(req, db);
        // 200 OK regardless of whether send-keys succeeded — the row should
        // exist as long as tmux new-window worked.
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          session_name: string;
          started: boolean;
          pid?: number;
          session_id?: string;
        };
        expect(body.started).toBe(true);
        expect(body.session_name).toContain("nexus-int-test-");

        const rows = await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, body.session_name));
        expect(rows).toHaveLength(1);
        const row = rows[0]!;

        // The whole point of fix-agent-cc-session-tracking 2.1.
        expect(row.pid).not.toBeNull();
        expect(row.pid!).toBeGreaterThan(0);
        expect(row.tmuxTarget).not.toBeNull();
        expect(row.tmuxTarget!.length).toBeGreaterThan(0);
        expect(row.cwd).not.toBeNull();
        expect(row.cwd!.length).toBeGreaterThan(0);
        expect(row.model).toBe("claude");

        // Cleanup: kill the tmux window we just created so the test is
        // isolated and the user's tmux session isn't littered.
        try {
          await runReal("tmux", ["kill-window", "-t", body.session_name]);
        } catch {
          // Best effort — the window may already be gone.
        }
      },
    );

    // ── nx-cvyxt: empty-cwd backfill from the session_start hook ───────────
    //
    // The process-watcher inserts a row with cwd="" whenever a live `claude`
    // PID doesn't match a tmux pane (cwd is hook-authoritative under the
    // /proc-free invariant, nx-9jz0v). A subsequent session_start hook MUST
    // backfill that row's cwd — but MUST NOT clobber a cwd that's already set.

    /** Minimal no-op SessionManager for processHookEvent's linkage branch. */
    function noopSessionManager(): SessionManager {
      return {
        handleWatcherEvent: () => {},
        getAll: () => [],
        getActive: () => [],
        getById: () => null,
        sweepIdle: () => {},
        stop: () => {},
        init: async () => {},
        updateLinkage: () => {},
        patch: () => {},
      } as unknown as SessionManager;
    }

    async function insertRow(id: string, cwd: string | null): Promise<void> {
      const now = new Date();
      await db.insert(sessions).values({
        id,
        machine: "local",
        status: "active",
        startedAt: now,
        lastActivity: now,
        pid: 0,
        cwd,
        model: "claude",
        sessionType: "managed",
        tmuxTarget: null,
        branch: null,
        endedAt: null,
        ccSessionId: null,
        projectId: null,
        tmuxSession: null,
        spec: null,
        credentialId: null,
        credentialFingerprint: null,
        rateLimitUtilization: null,
        totalCostUsd: null,
        rateLimitResetAt: null,
        idleSince: null,
      });
    }

    async function readCwd(id: string): Promise<string | null> {
      const rows = await db
        .select({ cwd: sessions.cwd })
        .from(sessions)
        .where(eq(sessions.id, id));
      return rows[0]?.cwd ?? null;
    }

    test("backfillSessionCwd fills an empty-string cwd row", async () => {
      await insertRow("bf-empty", "");
      const touched = await backfillSessionCwd(db, "bf-empty", "/Users/x/dev/nx");
      expect(touched).toBe(1);
      expect(await readCwd("bf-empty")).toBe("/Users/x/dev/nx");
    });

    test("backfillSessionCwd fills a NULL cwd row", async () => {
      await insertRow("bf-null", null);
      const touched = await backfillSessionCwd(db, "bf-null", "/Users/x/dev/nx");
      expect(touched).toBe(1);
      expect(await readCwd("bf-null")).toBe("/Users/x/dev/nx");
    });

    test("backfillSessionCwd does NOT overwrite an existing cwd", async () => {
      await insertRow("bf-existing", "/real/cwd/path");
      const touched = await backfillSessionCwd(db, "bf-existing", "/different/hook/cwd");
      expect(touched).toBe(0);
      // The real cwd survives — a later differing hook value never clobbers it.
      expect(await readCwd("bf-existing")).toBe("/real/cwd/path");
    });

    test("backfillSessionCwd is a no-op for a non-existent row", async () => {
      const touched = await backfillSessionCwd(db, "bf-missing", "/x");
      expect(touched).toBe(0);
    });

    test("session_start hook backfills an empty-cwd watcher row end-to-end", async () => {
      // Simulate the watcher inserting a PID-only row with no cwd.
      await insertRow("hook-empty", "");

      await processHookEvent(
        {
          eventType: "session_start",
          sessionId: "hook-empty",
          payload: { session_id: "hook-empty", cwd: "/Users/x/dev/nx" },
          source: "socket",
          cwd: "/Users/x/dev/nx",
        },
        { sessionManager: noopSessionManager(), db },
      );

      expect(await readCwd("hook-empty")).toBe("/Users/x/dev/nx");
    });

    test("session_start hook does NOT overwrite a row that already has a cwd", async () => {
      await insertRow("hook-existing", "/real/cwd/path");

      await processHookEvent(
        {
          eventType: "session_start",
          sessionId: "hook-existing",
          payload: { session_id: "hook-existing", cwd: "/different/hook/cwd" },
          source: "socket",
          cwd: "/different/hook/cwd",
        },
        { sessionManager: noopSessionManager(), db },
      );

      expect(await readCwd("hook-existing")).toBe("/real/cwd/path");
    });
  },
);
