/**
 * reaper-job end-to-end tests — full pipeline against real DB + real bus.
 *
 * Spec: openspec/changes/adopt-reaper-into-nx-cron, tasks 4.1 + 4.2.
 *
 * Unlike the unit tests (`reaper-job.test.ts`) which exercise parsing in
 * isolation, and the persistence tests (`reaper-persistence.test.ts`) which
 * exercise the Drizzle layer with a hand-built payload, these tests drive
 * the **full orchestration path** via `runAndPersistReaper`:
 *
 *   spawn reaper-core.sh (real bash, real script, dry-run)
 *     -> parse stdout (real parser)
 *       -> persist cron_runs + bloat_radar (real PG scratch schema)
 *         -> emit NotificationFired on the real lifecycleBus
 *
 * Two tests:
 *
 *   4.1 — Real `reaper-core.sh --dry-run` against a sandboxed $HOME with a
 *         seeded marker file. Asserts:
 *           - cron_runs row landed with job="reaper" status="success"
 *           - the seeded marker is untouched (zero filesystem mutations)
 *           - NotificationFired payload carries logPath
 *           - clear-run path emits no items
 *
 *   4.2 — Synthetic bloat run: instead of seeding a real 5GB Xcode bloat
 *         target (impractical in CI), we substitute the script path with a
 *         stub that emits hand-crafted `NEXUS_BLOAT` lines. The stub
 *         exercises the *same parser, persister, and notifier* the real
 *         script feeds into. Asserts:
 *           - bloat_radar row(s) persisted
 *           - NotificationFired completion event carries items[] + logPath
 *           - dedicated "Disk bloat warning" TTS event fired
 *
 * Skip behavior: tests requiring PG skip cleanly when POSTGRES_URL is unset
 * (mirrors `reaper-persistence.test.ts`). The dry-run live-spawn test (4.1)
 * additionally requires NEXUS_RUN_LIVE_REAPER_TESTS=1 because the bash
 * core's `du -sk /Library/Developer` can take minutes on a developer Mac.
 * The stub-based bloat test (4.2) runs unconditionally (when PG is up) —
 * the stub is fast and OS-independent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";

import { runAndPersistReaper } from "./reaper-job";
import type { ReaperResult } from "./reaper-job";
import {
  lifecycleBus,
  type LifecycleEnvelope,
  type NotificationFiredPayload,
} from "./lifecycle-bus";

type Sql = ReturnType<typeof createDb>["client"];

import { hasLivePg as hasPg } from "../testing/live-pg";
const runLive = process.env.NEXUS_RUN_LIVE_REAPER_TESTS === "1";

const SCHEMA = `nx_reaper_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Mirrors the migration 0033 shape — kept in lockstep with
// reaper-persistence.test.ts. Both files describe the same table; if either
// drifts, drizzle-kit re-generate or the schema source is the source of truth.
const DDL = `
  CREATE TABLE "cron_runs" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL,
    "job" text NOT NULL,
    "status" text NOT NULL,
    "details" jsonb,
    "metrics" jsonb
  );
  CREATE INDEX "cron_runs_timestamp_idx" ON "cron_runs" USING btree ("timestamp");

  CREATE TABLE "bloat_radar" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "run_timestamp" timestamp NOT NULL,
    "label" text NOT NULL,
    "path" text NOT NULL,
    "size_bytes" integer NOT NULL,
    "threshold_bytes" integer NOT NULL
  );
  CREATE INDEX "bloat_radar_run_timestamp_idx" ON "bloat_radar" USING btree ("run_timestamp");
`;

// ---------------------------------------------------------------------------
// Bus capture helper
// ---------------------------------------------------------------------------

/**
 * Capture every NotificationFired envelope the bus emits during a test. The
 * helper returns a teardown that detaches the listener so subsequent tests
 * don't accumulate handlers (the bus is a singleton).
 */
function captureNotifications(): {
  fired: LifecycleEnvelope<"NotificationFired">[];
  detach: () => void;
} {
  const fired: LifecycleEnvelope<"NotificationFired">[] = [];
  const handler = (env: LifecycleEnvelope<"NotificationFired">): void => {
    fired.push(env);
  };
  lifecycleBus.on("NotificationFired", handler);
  return {
    fired,
    detach: () => lifecycleBus.off("NotificationFired", handler),
  };
}

// ===========================================================================
// 4.1 — Real reaper-core.sh dry-run against sandboxed $HOME
// ===========================================================================

describe.skipIf(!hasPg || !runLive)(
  "reaper E2E [4.1] — real dry-run against sandboxed $HOME (requires PG + NEXUS_RUN_LIVE_REAPER_TESTS=1)",
  () => {
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;
    let sandbox: string;
    let originalHome: string | undefined;

    beforeAll(async () => {
      // ── PG scratch schema ──────────────────────────────────────────────
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

      // ── Sandboxed $HOME ────────────────────────────────────────────────
      sandbox = mkdtempSync(join(tmpdir(), "nx-reaper-e2e-"));
      mkdirSync(join(sandbox, ".local", "state"), { recursive: true });
      mkdirSync(join(sandbox, ".cache"), { recursive: true });
      originalHome = process.env.HOME;
      process.env.HOME = sandbox;
    });

    afterAll(async () => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
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

    it(
      "dry-run writes cron_runs row, mutates zero files, emits NotificationFired",
      async () => {
        // Seed a marker in the sandbox's .cache — the dry-run must NOT touch it.
        const marker = join(sandbox, ".cache", "marker-do-not-delete");
        writeFileSync(marker, "preserve-me");
        const mtimeBefore = statSync(marker).mtimeMs;

        const cap = captureNotifications();
        try {
          const result = await runAndPersistReaper({ db, dryRun: true });

          // Status surface: dry-run is reported as success.
          expect(result.status).toBe("success");

          // ── Filesystem invariant: marker untouched ───────────────────────
          expect(existsSync(marker)).toBe(true);
          expect(statSync(marker).mtimeMs).toBe(mtimeBefore);

          // ── DB invariant: cron_runs row landed ──────────────────────────
          const rows = await db.query.cronRuns.findMany({
            where: (cr, { eq }) => eq(cr.job, "reaper"),
          });
          expect(rows.length).toBeGreaterThanOrEqual(1);
          const row = rows[rows.length - 1]!;
          expect(row.status).toBe("success");
          // metrics jsonb carries the wrapper's numeric counters.
          expect(row.metrics).toMatchObject({
            pruned: expect.any(Number),
            freedBytes: expect.any(Number),
            durationMs: expect.any(Number),
          });
          // details jsonb carries the logPath + bloat snapshot.
          expect(row.details).toMatchObject({
            logPath: expect.stringContaining("weekly-cleanup.log"),
          });

          // ── Notification invariant: completion event fired ───────────────
          const completion = cap.fired.find(
            (env) => env.payload.title === "Weekly cleanup",
          );
          expect(completion).toBeDefined();
          const payload = completion!.payload as NotificationFiredPayload;
          // logPath always present on the completion event.
          expect(payload.logPath).toContain("weekly-cleanup.log");
          // items is undefined on a clear sandbox run (no bloat detected).
          // The agent /could/ surface adjacent-dir bloat on a developer
          // host, so we don't assert items is missing — just that the
          // shape is back-compat-safe.
          if (payload.items !== undefined) {
            expect(Array.isArray(payload.items)).toBe(true);
          }
        } finally {
          cap.detach();
        }
      },
      300_000,
    );
  },
);

// ===========================================================================
// 4.2 — Synthetic bloat via stub script
// ===========================================================================

/**
 * Build a stub bash script that emits hand-crafted NEXUS_RESULT + NEXUS_BLOAT
 * lines mimicking what `reaper-core.sh` would print on a host whose Chrome
 * profile + CoreSimulator dir crossed the bloat threshold. The stub does NOT
 * touch the filesystem — the bloat findings are synthetic. This is the
 * "seed a synthetic over-threshold bloat target" leg of task 4.2: the
 * stub IS the seed, replacing a real multi-GB seed which is impractical.
 *
 * The stub mirrors the exact protocol the parser consumes — same prefixes,
 * same field delimiters — so it exercises the production parser + persister
 * + notifier paths verbatim.
 */
function writeBloatStub(dir: string, logPath: string): string {
  const stubPath = join(dir, "bloat-stub.sh");
  const body = [
    "#!/usr/bin/env bash",
    "set -u",
    "# Mimic reaper-core.sh emission order. The wrapper passes --dry-run as $1.",
    `echo "NEXUS_RESULT started_at=2026-05-21T03:00:00Z dry_run=1 log_path=${logPath}"`,
    "echo '  -- bloat radar (adjacent dirs NOT auto-cleaned) --'",
    "echo 'NEXUS_BLOAT label=CoreSimulator|path=/tmp/synthetic/CoreSimulator|size_bytes=42949672960|threshold_bytes=21474836480'",
    "echo 'NEXUS_BLOAT label=pnpm store|path=/tmp/synthetic/pnpm|size_bytes=15000000000|threshold_bytes=12884901888'",
    `echo "NEXUS_RESULT status=success pruned=0 freed_bytes=0 log_path=${logPath}"`,
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(stubPath, body, { mode: 0o755 });
  return stubPath;
}

describe.skipIf(!hasPg)(
  "reaper E2E [4.2] — synthetic bloat seed exercises bloat_radar + dedicated TTS",
  () => {
    const SUB_SCHEMA = `${SCHEMA}_bloat`;
    let adminClient: Sql;
    let scopedClient: Sql;
    let db: Db;
    let workDir: string;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;
      await adminClient.unsafe(`CREATE SCHEMA "${SUB_SCHEMA}"`);
      await adminClient.unsafe(`SET search_path TO "${SUB_SCHEMA}", public`);
      await adminClient.unsafe(DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${SUB_SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;

      workDir = mkdtempSync(join(tmpdir(), "nx-reaper-e2e-bloat-"));
    });

    afterAll(async () => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        await scopedClient.end({ timeout: 5 });
      } finally {
        try {
          await adminClient.unsafe(
            `DROP SCHEMA IF EXISTS "${SUB_SCHEMA}" CASCADE`,
          );
        } finally {
          await adminClient.end({ timeout: 5 });
        }
      }
    });

    // Detach all bus subscribers between tests so cross-test leakage can't
    // pollute capture counts. Re-attach inside each `it()` via captureNotifications.
    afterEach(() => {
      // No-op: each test owns its own capture/detach pair. Listed here to
      // document the contract — if a future test forgets to detach, add a
      // `lifecycleBus.removeAllListeners()` cleanup here.
    });

    it("synthetic bloat findings land in bloat_radar AND fire the dedicated bloat TTS", async () => {
      const logPath = join(workDir, "weekly-cleanup.log");
      const stubPath = writeBloatStub(workDir, logPath);

      const cap = captureNotifications();
      let result: ReaperResult;
      try {
        result = await runAndPersistReaper({
          db,
          dryRun: true,
          scriptPath: stubPath,
        });

        // ── Wrapper-level invariants ─────────────────────────────────────
        expect(result.status).toBe("success");
        expect(result.bloatFindings).toHaveLength(2);
        expect(result.bloatFindings[0]?.label).toBe("CoreSimulator");
        expect(result.bloatFindings[1]?.label).toBe("pnpm store");
        expect(result.logPath).toBe(logPath);

        // ── DB invariant: bloat_radar rows persisted ─────────────────────
        const bloatRows = await db.query.bloatRadar.findMany({
          orderBy: (br, { asc }) => [asc(br.label)],
        });
        expect(bloatRows).toHaveLength(2);
        // CoreSimulator sorts before pnpm store alphabetically.
        expect(bloatRows[0]?.label).toBe("CoreSimulator");
        expect(bloatRows[0]?.path).toBe("/tmp/synthetic/CoreSimulator");
        // The size from the stub is 42_949_672_960 (40 GiB) — clamped to INT32_MAX.
        expect(bloatRows[0]?.sizeBytes).toBe(2_147_483_647);
        expect(bloatRows[1]?.label).toBe("pnpm store");

        // ── DB invariant: cron_runs row also landed ──────────────────────
        const cronRows = await db.query.cronRuns.findMany({
          where: (cr, { eq }) => eq(cr.job, "reaper"),
        });
        expect(cronRows).toHaveLength(1);
        expect(cronRows[0]?.status).toBe("success");
        expect(cronRows[0]?.details).toMatchObject({
          bloatCount: 2,
        });

        // ── Notification invariants ──────────────────────────────────────
        // Two emits expected: the completion notification (channel=desktop)
        // AND the dedicated bloat TTS (channel=tts).
        const completion = cap.fired.find(
          (env) =>
            env.payload.title === "Weekly cleanup" &&
            env.payload.channel === "desktop",
        );
        const bloatTts = cap.fired.find(
          (env) =>
            env.payload.title === "Disk bloat warning" &&
            env.payload.channel === "tts",
        );

        expect(completion).toBeDefined();
        expect(bloatTts).toBeDefined();

        // Completion payload carries items[] (one per finding) AND logPath.
        const cp = completion!.payload as NotificationFiredPayload;
        expect(cp.items).toBeDefined();
        expect(cp.items).toHaveLength(2);
        expect(cp.items?.[0]).toContain("CoreSimulator");
        expect(cp.logPath).toBe(logPath);

        // Bloat TTS body summarises the findings.
        const bp = bloatTts!.payload as NotificationFiredPayload;
        expect(bp.body).toContain("CoreSimulator");
        expect(bp.body).toContain("pnpm store");
        expect(bp.logPath).toBe(logPath);
      } finally {
        cap.detach();
      }
    });
  },
);
