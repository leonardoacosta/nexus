/**
 * data-integrity-scan — weekly, READ-ONLY cron job that scans for known
 * bad-data signatures and alerts (never repairs).
 *
 * Spec: openspec/changes/nexus-self-healing-infra (db-integrity capability).
 *
 * The one signature implemented here mirrors the migration-0049 incident
 * (`packages/db/drizzle/0049_thick_ravenous.sql`): `projects` rows that
 * should share a unique (name, NULL git_remote_url) identity but don't,
 * because the partial unique index `projects_name_null_remote_unique` did
 * not exist yet when the auto-discovery scanner's `onConflictDoNothing()`
 * silently inserted duplicates every ~60s cycle. That index now exists
 * (added by the same migration), so this job is a regression detector, not
 * an expected-to-fire alarm — if it ever fires again, either the index was
 * dropped or a new code path bypasses it.
 *
 * Detection query mirrors migration 0049's own `dup_names` CTE WHERE/GROUP
 * BY shape exactly: rows with `git_remote_url IS NULL`, grouped by `name`,
 * `HAVING COUNT(*) > 1`. This module performs ONLY that `SELECT` — zero
 * INSERT/UPDATE/DELETE anywhere in this file, on any code path, per Leo's
 * explicit Non-Goals decision (detect + alert only, never auto-repair).
 *
 * Notification cooldown mirrors `reaper-job.ts`'s
 * `emitStaleHeartbeatNotification` / `deploy-staleness.ts`'s
 * `emitDeployStalenessNotification` shape: a single cooldown constant + a
 * `state-snapshot`-persisted last-notify timestamp.
 */

import { createLogger } from "@nexus/core/node";
import type { Db, NewCronRun } from "@nexus/db";
import { cronRuns, isNull, projects, sql } from "@nexus/db";
import { lifecycleBus } from "./lifecycle-bus";
import { registerSnapshotSource } from "./state-snapshot";

const log = createLogger("agent:data-integrity-scan");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DuplicateProjectFinding {
  name: string;
  duplicateCount: number;
}

export interface DataIntegrityResult {
  status: "success" | "failure";
  findings: DuplicateProjectFinding[];
  error?: string;
}

/**
 * Cooldown between data-integrity notifications — same 12h shape as
 * `reaper-job.ts` / `deploy-staleness.ts`: avoid re-alerting on every weekly
 * tick while a known-bad state is being worked on, while still surfacing it
 * a couple of times a day if it persists.
 */
export const DATA_INTEGRITY_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Manual repair pointer surfaced in the notification body. This job never
 * writes — an operator must review and run the equivalent of migration
 * 0049's dedupe (pick a canonical row per duplicate group, re-point
 * `sessions`/`project_locations`, delete the rest) by hand.
 */
const MANUAL_REPAIR_COMMAND =
  "review packages/db/drizzle/0049_thick_ravenous.sql's dedupe pattern " +
  "(SELECT name, COUNT(*) FROM projects WHERE git_remote_url IS NULL GROUP BY name HAVING COUNT(*) > 1) " +
  "and apply the same canonical-row merge manually — this job never writes";

// ---------------------------------------------------------------------------
// Detection (read-only)
// ---------------------------------------------------------------------------

/**
 * Scan `projects` for the migration-0049 duplicate-identity signature.
 * READ-ONLY — a single `SELECT ... GROUP BY ... HAVING`, no writes.
 * Exported for unit tests.
 */
export async function scanProjectDuplicates(db: Db): Promise<DuplicateProjectFinding[]> {
  const rows = await db
    .select({
      name: projects.name,
      duplicateCount: sql<number>`COUNT(*)`,
    })
    .from(projects)
    .where(isNull(projects.gitRemoteUrl))
    .groupBy(projects.name)
    .having(sql`COUNT(*) > 1`);

  return rows.map((r) => ({ name: r.name, duplicateCount: Number(r.duplicateCount) }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistDataIntegrityOpts {
  db: Db;
  result: DataIntegrityResult;
  /** Defaults to `new Date()` — overridable for deterministic tests. */
  timestamp?: Date;
}

export async function persistDataIntegrityResult(
  opts: PersistDataIntegrityOpts,
): Promise<{ cronRunId: number }> {
  const { db, result } = opts;
  const timestamp = opts.timestamp ?? new Date();

  const detailsJson = {
    table: "projects",
    findings: result.findings,
    error: result.error,
  };
  const metricsJson = {
    duplicateGroupCount: result.findings.length,
    duplicateRowCount: result.findings.reduce((sum, f) => sum + f.duplicateCount, 0),
  };

  const newRow: NewCronRun = {
    timestamp,
    job: "data-integrity",
    status: result.status,
    details: detailsJson,
    metrics: metricsJson,
  };

  const [inserted] = await db.insert(cronRuns).values(newRow).returning({ id: cronRuns.id });
  if (!inserted) {
    throw new Error("cronRuns insert returned no rows");
  }

  log.info(
    {
      cronRunId: inserted.id,
      status: result.status,
      duplicateGroupCount: result.findings.length,
    },
    "data-integrity: persisted run",
  );

  return { cronRunId: inserted.id };
}

// ---------------------------------------------------------------------------
// Notification emission
// ---------------------------------------------------------------------------

let lastDataIntegrityNotifyAt: number | null = null;

registerSnapshotSource("data-integrity-notify", {
  serialize: () => lastDataIntegrityNotifyAt,
  deserialize: (data) => {
    lastDataIntegrityNotifyAt = typeof data === "number" ? data : null;
  },
});

/** Test-only: reset cooldown state between cases. */
export function __resetDataIntegrityNotifyForTests(): void {
  lastDataIntegrityNotifyAt = null;
}

/**
 * Emit a data-integrity warning naming the affected table, the duplicate
 * group count, and the manual repair command, gated by
 * `DATA_INTEGRITY_NOTIFY_COOLDOWN_MS`. Returns `true` when the notification
 * was actually emitted, `false` when suppressed by an active cooldown or
 * when `findings` is empty.
 */
export function emitDataIntegrityNotification(
  findings: DuplicateProjectFinding[],
  now: Date = new Date(),
): boolean {
  if (findings.length === 0) return false;

  const nowMs = now.getTime();
  if (
    lastDataIntegrityNotifyAt !== null &&
    nowMs - lastDataIntegrityNotifyAt < DATA_INTEGRITY_NOTIFY_COOLDOWN_MS
  ) {
    log.debug(
      {
        lastNotifyAt: new Date(lastDataIntegrityNotifyAt).toISOString(),
        cooldownMs: DATA_INTEGRITY_NOTIFY_COOLDOWN_MS,
      },
      "data-integrity: notification suppressed (cooldown active)",
    );
    return false;
  }
  lastDataIntegrityNotifyAt = nowMs;

  const totalRows = findings.reduce((sum, f) => sum + f.duplicateCount, 0);
  const sample = findings
    .slice(0, 3)
    .map((f) => `${f.name} x${f.duplicateCount}`)
    .join(", ");
  const body =
    `projects: ${findings.length} duplicate-identity group(s) found ` +
    `(${totalRows} row(s) total; e.g. ${sample}). Manual repair: ${MANUAL_REPAIR_COMMAND}.`;

  lifecycleBus.emit("NotificationFired", {
    id: `data-integrity-${Date.now()}`,
    title: "Data integrity WARNING",
    body,
    channel: "desktop",
    message: body,
  });

  lifecycleBus.emit("NotificationFired", {
    id: `data-integrity-tts-${Date.now()}`,
    title: "Data integrity WARNING",
    body,
    channel: "tts",
    message: body,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Public orchestration entrypoint
// ---------------------------------------------------------------------------

export interface RunDataIntegrityScanOpts {
  db: Db;
  /** Defaults to `new Date()` — overridable for tests. */
  timestamp?: Date;
  /** Skip lifecycle-bus emit (e.g. during ad-hoc / dry-run smoke tests). */
  suppressNotifications?: boolean;
}

/**
 * High-level entrypoint used by `cron.ts`: run the read-only scan, persist
 * the result, and emit the notification (if any findings). Never throws — a
 * query failure (connection drop, timeout) is caught and persisted as
 * `status: "failure"` so the cron service's own outer try/catch is a pure
 * backstop, and other scheduled jobs are unaffected either way.
 */
export async function runAndPersistDataIntegrityScan(
  opts: RunDataIntegrityScanOpts,
): Promise<DataIntegrityResult> {
  const { db } = opts;
  const now = opts.timestamp ?? new Date();

  let result: DataIntegrityResult;
  try {
    const findings = await scanProjectDuplicates(db);
    result = { status: "success", findings };
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "data-integrity: scan failed",
    );
    result = {
      status: "failure",
      findings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await persistDataIntegrityResult({ db, result, timestamp: now });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "data-integrity: persist failed (continuing to notification emit)",
    );
  }

  if (!opts.suppressNotifications && result.status === "success" && result.findings.length > 0) {
    emitDataIntegrityNotification(result.findings, now);
  }

  return result;
}
