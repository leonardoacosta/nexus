import type { Db } from "@nexus/db";
import {
  bloatRadar,
  credentialEvents,
  cronRuns,
  healthSnapshots,
  projectStatusSnapshots,
  sessionEvents,
  specSessions,
  specSnapshots,
} from "@nexus/db";
import { lt } from "drizzle-orm";
import { logger } from "@nexus/core/node";
import { safeFireAndForget } from "../utils/safe-fire-and-forget";

const HEALTH_RETENTION_DAYS = Number(process.env.HEALTH_RETENTION_DAYS ?? "30");
const EVENTS_RETENTION_DAYS = 90;
const CREDENTIAL_EVENTS_RETENTION_DAYS = 30;
// Per adopt-reaper-into-nx-cron: 90-day window mirrors session_events — long
// enough for quarterly bloat-radar trend review, short enough to keep the
// table small. Override via env for ops sweeps.
const CRON_RUNS_RETENTION_DAYS = Number(
  process.env.CRON_RUNS_RETENTION_DAYS ?? "90",
);
const BLOAT_RADAR_RETENTION_DAYS = Number(
  process.env.BLOAT_RADAR_RETENTION_DAYS ?? "90",
);
// Per specs-tab-start-on-spec: 365-day window because this powers the
// dashboard's historical lookup ("which sessions touched spec X?") that the
// user navigates to from a row chip — not a trend dashboard. Longer than
// cron_runs (90d) deliberately.
const SPEC_SESSIONS_RETENTION_DAYS = Number(
  process.env.SPEC_SESSIONS_RETENTION_DAYS ?? "365",
);
// Per add-project-status-snapshots: 90-day window mirrors cron_runs/bloat_radar
// — long enough for trend/velocity dashboards, short enough to keep the
// change-only time-series tables small. Override via env for ops sweeps.
const SPEC_SNAPSHOTS_RETENTION_DAYS = Number(
  process.env.SPEC_SNAPSHOTS_RETENTION_DAYS ?? "90",
);
const PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS = Number(
  process.env.PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS ?? "90",
);
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete telemetry rows past their retention window:
 *   - health_snapshots   > 30 days
 *   - session_events     > 90 days
 *   - credential_events  > 30 days
 *   - cron_runs          > 90 days   (adopt-reaper-into-nx-cron)
 *   - bloat_radar        > 90 days   (adopt-reaper-into-nx-cron)
 *   - spec_sessions      > 365 days  (specs-tab-start-on-spec)
 *   - spec_snapshots            > 90 days  (add-project-status-snapshots)
 *   - project_status_snapshots  > 90 days  (add-project-status-snapshots)
 */
export async function runRetentionCleanup(db: Db): Promise<void> {
  const healthCutoff = new Date(
    Date.now() - HEALTH_RETENTION_DAYS * 86_400_000,
  );
  const eventsCutoff = new Date(
    Date.now() - EVENTS_RETENTION_DAYS * 86_400_000,
  );
  const credentialEventsCutoff = new Date(
    Date.now() - CREDENTIAL_EVENTS_RETENTION_DAYS * 86_400_000,
  );
  const cronRunsCutoff = new Date(
    Date.now() - CRON_RUNS_RETENTION_DAYS * 86_400_000,
  );
  const bloatRadarCutoff = new Date(
    Date.now() - BLOAT_RADAR_RETENTION_DAYS * 86_400_000,
  );
  const specSessionsCutoff = new Date(
    Date.now() - SPEC_SESSIONS_RETENTION_DAYS * 86_400_000,
  );
  const specSnapshotsCutoff = new Date(
    Date.now() - SPEC_SNAPSHOTS_RETENTION_DAYS * 86_400_000,
  );
  const projectStatusSnapshotsCutoff = new Date(
    Date.now() - PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS * 86_400_000,
  );

  const healthDeleted = await db
    .delete(healthSnapshots)
    .where(lt(healthSnapshots.timestamp, healthCutoff));
  const eventsDeleted = await db
    .delete(sessionEvents)
    .where(lt(sessionEvents.timestamp, eventsCutoff));
  const credentialEventsDeleted = await db
    .delete(credentialEvents)
    .where(lt(credentialEvents.createdAt, credentialEventsCutoff));
  const cronRunsDeleted = await db
    .delete(cronRuns)
    .where(lt(cronRuns.timestamp, cronRunsCutoff));
  const bloatRadarDeleted = await db
    .delete(bloatRadar)
    .where(lt(bloatRadar.runTimestamp, bloatRadarCutoff));
  const specSessionsDeleted = await db
    .delete(specSessions)
    .where(lt(specSessions.createdAt, specSessionsCutoff));
  const specSnapshotsDeleted = await db
    .delete(specSnapshots)
    .where(lt(specSnapshots.createdAt, specSnapshotsCutoff));
  const projectStatusSnapshotsDeleted = await db
    .delete(projectStatusSnapshots)
    .where(lt(projectStatusSnapshots.createdAt, projectStatusSnapshotsCutoff));

  logger.info({
    health_deleted: healthDeleted.count,
    events_deleted: eventsDeleted.count,
    credential_events_deleted: credentialEventsDeleted.count,
    cron_runs_deleted: cronRunsDeleted.count,
    bloat_radar_deleted: bloatRadarDeleted.count,
    spec_sessions_deleted: specSessionsDeleted.count,
    spec_snapshots_deleted: specSnapshotsDeleted.count,
    project_status_snapshots_deleted: projectStatusSnapshotsDeleted.count,
  }, "retention cleanup complete");
}

/**
 * Run retention cleanup immediately, then schedule it to repeat every 24
 * hours. Returns a cleanup function that cancels the interval.
 */
export function scheduleRetention(db: Db): () => void {
  safeFireAndForget(runRetentionCleanup(db), "retention-cleanup");

  const timer = setInterval(() => {
    safeFireAndForget(runRetentionCleanup(db), "retention-cleanup");
  }, CLEANUP_INTERVAL_MS);

  return () => clearInterval(timer);
}
