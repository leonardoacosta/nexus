/**
 * Tests for `GET /health/process-watcher` + `ProcessWatcherStalled` alert.
 *
 * Spec: process-watcher-health-monitoring.
 *
 * Two layers:
 *
 *   1. Shape contract (always runs, no PG required) — fake Db verifies the
 *      response body keys + 200 status + `healthy` boolean semantics.
 *
 *   2. PG-gated round-trip — spins up an isolated schema, drives
 *      `reconcileOnce()` directly (with a stubbed `pgrep` so we control the
 *      live-pid count + the error path), and asserts:
 *        a) a healthy tick → `/health/process-watcher` reports `healthy: true`.
 *        b) a tick whose error path fires → `ProcessWatcherStalled` lands on
 *           the lifecycle bus.
 *
 * Mock contract: `../utils/exec` is intercepted BEFORE the watcher module is
 * imported (same pattern as `process-watcher.integration.test.ts`). Only
 * `pgrep` is stubbed; tmux / which fall through to a real subprocess so the
 * `tmuxScan()` pass inside reconcileOnce doesn't crash.
 */

import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";
import type { Db } from "@nexus/db";
import { createDb } from "@nexus/db";

// ─── Real-subprocess passthrough (independent of ../utils/exec mock) ──────

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

async function runReal(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
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

// ─── Mock subprocess exec BEFORE importing the watcher / route ────────────

type ExecMode = "ok-empty" | "throw";
let pgrepStubLines: string[] = [];
let execMode: ExecMode = "ok-empty";

function setPgrepStub(lines: string[]): void {
  pgrepStubLines = lines;
}
function setExecMode(mode: ExecMode): void {
  execMode = mode;
}

mock.module("../utils/exec", () => ({
  execText: mock(async (cmd: string, args: string[]) => {
    if (cmd === "pgrep" && args[0] === "-af" && args[1] === "claude") {
      if (execMode === "throw") {
        throw new Error("pgrep stub: synthetic stalled-tick failure");
      }
      return pgrepStubLines.join("\n");
    }
    return runReal(cmd, args);
  }),
  execJson: mock(async (cmd: string, args: string[]) => {
    const out = await runReal(cmd, args);
    return JSON.parse(out);
  }),
  ExecError: _ExecError,
  ExecTimeoutError: class extends Error {},
}));

// ─── Imports AFTER mock registration ──────────────────────────────────────

import { handleHealthProcessWatcher } from "./health-process-watcher";
import { reconcileOnce } from "../services/process-watcher";
import { lifecycleBus } from "../services/lifecycle-bus";

// =========================================================================
// Layer 1: shape contract (no PG required)
// =========================================================================

function makeFakeDbForStaleCount(staleCount: number): Db {
  // Mirrors the shape `staleRowCount()` expects from db.execute(sql`...`)
  return {
    execute: () => Promise.resolve({ rows: [{ count: staleCount }] }),
  } as unknown as Db;
}

describe("handleHealthProcessWatcher — shape contract", () => {
  test("returns 200 with the documented field set", async () => {
    const db = makeFakeDbForStaleCount(0);
    const res = await handleHealthProcessWatcher(db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    // Every documented key MUST be present (even if null).
    const expectedKeys = [
      "lastTickMs",
      "lastTickAgoSeconds",
      "lastReconcileError",
      "livePidCount",
      "staleRowCount",
      "resolverCacheHitRatio",
      "healthy",
    ];
    for (const key of expectedKeys) {
      expect(body).toHaveProperty(key);
    }

    // Type-shape sanity
    expect(typeof body.healthy).toBe("boolean");
    expect(typeof body.livePidCount).toBe("number");
    expect(typeof body.staleRowCount).toBe("number");
    expect(typeof body.resolverCacheHitRatio).toBe("number");
  });

  test("threads staleRowCount value through to the response", async () => {
    const db = makeFakeDbForStaleCount(7);
    const res = await handleHealthProcessWatcher(db);
    const body = (await res.json()) as { staleRowCount: number };
    expect(body.staleRowCount).toBe(7);
  });

  test("staleRowCount fails-soft to 0 when the db query throws", async () => {
    const db = {
      execute: () => {
        throw new Error("db unreachable");
      },
    } as unknown as Db;
    const res = await handleHealthProcessWatcher(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staleRowCount: number };
    expect(body.staleRowCount).toBe(0);
  });
});

// =========================================================================
// Layer 2: PG-gated round-trip + stalled-alert
// =========================================================================

const hasPg = !!process.env.POSTGRES_URL;

if (!hasPg) {
  // eslint-disable-next-line no-console
  console.log(
    "[health-process-watcher.test] POSTGRES_URL not set — skipping reconcile-driven tests",
  );
}

const HPW_SCHEMA = `nx_hpw_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const HPW_DDL = `
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
    "git_owner_repo" text
  );

  CREATE TABLE "process_watcher_state" (
    "id" serial PRIMARY KEY NOT NULL,
    "observed_at" timestamp DEFAULT now() NOT NULL,
    "live_pid_count" integer NOT NULL,
    "tick_duration_ms" integer NOT NULL,
    "error_text" text
  );
`;

describe.skipIf(!hasPg)(
  "/health/process-watcher — reconcile-driven (requires live PG)",
  () => {
    let adminClient: ReturnType<typeof createDb>["client"];
    let scopedClient: ReturnType<typeof createDb>["client"];
    let db: Db;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;

      await adminClient.unsafe(`CREATE SCHEMA "${HPW_SCHEMA}"`);
      await adminClient.unsafe(`SET search_path TO "${HPW_SCHEMA}", public`);
      await adminClient.unsafe(HPW_DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${HPW_SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;
    });

    afterAll(async () => {
      try {
        await scopedClient.end({ timeout: 5 });
      } finally {
        try {
          await adminClient.unsafe(`DROP SCHEMA IF EXISTS "${HPW_SCHEMA}" CASCADE`);
        } finally {
          await adminClient.end({ timeout: 5 });
        }
      }
    });

    beforeEach(async () => {
      await scopedClient.unsafe(`DELETE FROM "${HPW_SCHEMA}"."sessions"`);
      await scopedClient.unsafe(
        `DELETE FROM "${HPW_SCHEMA}"."process_watcher_state"`,
      );
      setExecMode("ok-empty");
      setPgrepStub([]);
    });

    test("after a successful reconcile tick, /health/process-watcher reports healthy: true", async () => {
      // Drive one healthy tick — pgrep stub returns no processes (empty), no
      // error path. `reconcileOnce` updates the module-level liveness state.
      setExecMode("ok-empty");
      setPgrepStub([]);
      await reconcileOnce(db);

      const res = await handleHealthProcessWatcher(db);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        lastTickMs: number | null;
        lastTickAgoSeconds: number | null;
        lastReconcileError: string | null;
        livePidCount: number;
        staleRowCount: number;
        resolverCacheHitRatio: number;
        healthy: boolean;
      };

      expect(body.lastTickMs).not.toBeNull();
      expect(body.lastTickAgoSeconds).not.toBeNull();
      expect(body.lastTickAgoSeconds!).toBeLessThan(90);
      expect(body.lastReconcileError).toBeNull();
      expect(body.healthy).toBe(true);
    });

    test("a tick whose error path fires emits ProcessWatcherStalled on the lifecycle bus", async () => {
      // Subscribe BEFORE driving the failing tick so we don't miss the emit.
      const captured: Array<{
        tickAgeSeconds: number;
        errorText: string | null;
        livePidCount: number;
      }> = [];
      const handler = (envelope: {
        payload: {
          tickAgeSeconds: number;
          errorText: string | null;
          livePidCount: number;
        };
      }): void => {
        captured.push(envelope.payload);
      };
      lifecycleBus.on("ProcessWatcherStalled", handler);

      try {
        // Force the pgrep stub to throw — reconcileOnce catches the error,
        // stashes the message into `lastReconcileError`, persists a tick row
        // with `errorText`, and `maybeEmitStalled` fires the event because
        // `errorText !== null`.
        setExecMode("throw");
        await reconcileOnce(db);

        // EventEmitter delivers synchronously, so the event should be in
        // `captured` already — but give the microtask queue one tick of
        // breathing room in case the bus is ever made async.
        await Promise.resolve();

        expect(captured.length).toBeGreaterThanOrEqual(1);
        const evt = captured[0]!;
        expect(evt.errorText).toContain("synthetic stalled-tick failure");
        expect(typeof evt.tickAgeSeconds).toBe("number");
        expect(typeof evt.livePidCount).toBe("number");

        // Cross-check via the route: lastReconcileError MUST surface the
        // same error text we threw from the pgrep stub.
        const res = await handleHealthProcessWatcher(db);
        const body = (await res.json()) as { lastReconcileError: string | null };
        expect(body.lastReconcileError).toContain("synthetic stalled-tick failure");
      } finally {
        lifecycleBus.off("ProcessWatcherStalled", handler);
        // Reset module-level error so subsequent tests don't see it.
        setExecMode("ok-empty");
        await reconcileOnce(db);
      }
    });
  },
);
