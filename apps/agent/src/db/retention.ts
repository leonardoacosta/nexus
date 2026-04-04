import type { Database } from "bun:sqlite";
import { logger } from "@nexus/core";

const HEALTH_RETENTION_DAYS = 30;
const EVENTS_RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete health_snapshots older than 30 days and session_events older than
 * 90 days.
 */
export function runRetentionCleanup(db: Database): void {
  const healthCutoff = new Date(
    Date.now() - HEALTH_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  const eventsCutoff = new Date(
    Date.now() - EVENTS_RETENTION_DAYS * 86_400_000,
  ).toISOString();

  const healthDeleted = db
    .query(`DELETE FROM health_snapshots WHERE timestamp < $cutoff`)
    .run({ $cutoff: healthCutoff });
  const eventsDeleted = db
    .query(`DELETE FROM session_events WHERE timestamp < $cutoff`)
    .run({ $cutoff: eventsCutoff });

  logger.info("retention cleanup complete", {
    health_deleted: healthDeleted.changes,
    events_deleted: eventsDeleted.changes,
  });
}

/**
 * Run retention cleanup immediately, then schedule it to repeat every 24
 * hours.  Returns a cleanup function that cancels the interval.
 */
export function scheduleRetention(db: Database): () => void {
  runRetentionCleanup(db);

  const timer = setInterval(() => {
    runRetentionCleanup(db);
  }, CLEANUP_INTERVAL_MS);

  return () => clearInterval(timer);
}
