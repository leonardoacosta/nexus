import type { Db } from "@nexus/db";
import {
  bloatRadar,
  credentialEvents,
  cronRuns,
  healthSnapshots,
  sessionEvents,
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
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete telemetry rows past their retention window:
 *   - health_snapshots   > 30 days
 *   - session_events     > 90 days
 *   - credential_events  > 30 days
 *   - cron_runs          > 90 days  (adopt-reaper-into-nx-cron)
 *   - bloat_radar        > 90 days  (adopt-reaper-into-nx-cron)
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

  logger.info({
    health_deleted: healthDeleted.count,
    events_deleted: eventsDeleted.count,
    credential_events_deleted: credentialEventsDeleted.count,
    cron_runs_deleted: cronRunsDeleted.count,
    bloat_radar_deleted: bloatRadarDeleted.count,
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
