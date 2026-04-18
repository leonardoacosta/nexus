import type { Db } from "@nexus/db";
import { healthSnapshots, sessionEvents, credentialEvents } from "@nexus/db";
import { lt } from "drizzle-orm";
import { logger } from "@nexus/core/node";
import { safeFireAndForget } from "../utils/safe-fire-and-forget";

const HEALTH_RETENTION_DAYS = Number(process.env.HEALTH_RETENTION_DAYS ?? "30");
const EVENTS_RETENTION_DAYS = 90;
const CREDENTIAL_EVENTS_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete health_snapshots older than 30 days, session_events older than
 * 90 days, and credential_events older than 30 days.
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

  const healthDeleted = await db
    .delete(healthSnapshots)
    .where(lt(healthSnapshots.timestamp, healthCutoff));
  const eventsDeleted = await db
    .delete(sessionEvents)
    .where(lt(sessionEvents.timestamp, eventsCutoff));
  const credentialEventsDeleted = await db
    .delete(credentialEvents)
    .where(lt(credentialEvents.createdAt, credentialEventsCutoff));

  logger.info({
    health_deleted: healthDeleted.count,
    events_deleted: eventsDeleted.count,
    credential_events_deleted: credentialEventsDeleted.count,
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
