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
import { createDb, sessions, eq } from "@nexus/db";
import type { Db } from "@nexus/db";

type Sql = ReturnType<typeof createDb>["client"];

// ── Environment probe ──────────────────────────────────────────────────────

const TMUX_AVAILABLE = Bun.which("tmux") !== null;
const hasPg = !!process.env.POSTGRES_URL;

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
    "credential_fingerprint" text
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
      setPgrepStub([]);
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
  },
);
