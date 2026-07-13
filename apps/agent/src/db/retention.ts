import type { Db } from "@nexus/db";
import {
  bloatRadar,
  credentialEvents,
  credentials,
  cronRuns,
  gitEvents,
  healthSnapshots,
  projectStatusSnapshots,
  sessionEvents,
  specSessions,
  specSnapshots,
} from "@nexus/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
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
// Per add-git-status-orbit: 90-day window mirrors cron_runs/project_status_
// snapshots — long enough for orbital git-history review, short enough to keep
// the append-only event table small. Override via env for ops sweeps.
const GIT_EVENTS_RETENTION_DAYS = Number(
  process.env.GIT_EVENTS_RETENTION_DAYS ?? "90",
);
// Per nx-lp8v/nx-m5q6 (credentials table bloat — 2,709 rows / 4.03MB payload
// with only 1 isActive): mirrors credential_events' 30-day precedent above.
// Deliberately conservative — see the predicate comment on
// deleteStaleCredentials() for exactly which rows this window applies to.
const CREDENTIALS_RETENTION_DAYS = Number(
  process.env.CREDENTIALS_RETENTION_DAYS ?? "30",
);
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete `credentials` rows we can prove are safely dead, past
 * `CREDENTIALS_RETENTION_DAYS` since last touched. Two independent
 * predicates, either of which qualifies a row for deletion:
 *
 *   1. `status = 'refresh_failed'` — the OAuth server explicitly rejected
 *      this row's refresh token (`credential-refresh-job.ts` sets this on
 *      `invalid_grant`). This is the primary sweep for the nx-lp8v/nx-m5q6
 *      root cause: `active-credential-watcher.ts` used to mint a brand-new
 *      `isPrimary = true`, singleton-duplicate-group row on every refresh-
 *      token rotation instead of updating the previous row in place. Those
 *      orphaned rows are NOT `isPrimary = false` (each is first-and-only in
 *      its own group), so a naive `isPrimary = false` filter would miss
 *      almost the entire backlog — confirmed by reading `pool-core.ts`'s
 *      `add()` duplicate-group logic, not assumed. `credential-refresh-job`
 *      already sweeps every `available` row with an expired access token
 *      (excluding only the live active fingerprint) every 5 minutes and
 *      flips it to `refresh_failed` on `invalid_grant`, so this predicate
 *      catches the backlog once that job has had a chance to run.
 *   2. `is_primary = false` — non-primary duplicate-group members are
 *      already excluded from `CredentialPool.lease()` by design (see
 *      `pool-core.ts` lease()'s `eq(credentials.isPrimary, true)` filter),
 *      so an old, unleased one carries zero operational value — it can
 *      never be leased regardless of its `status`.
 *
 * Both predicates additionally require `leased_by IS NULL` as a hard safety
 * belt (never delete a row currently checked out to a caller) and
 * `updated_at` older than the retention window (never delete something
 * touched recently, even if it happens to match on status/isPrimary).
 *
 * Deliberately does NOT delete `isPrimary = true, status = 'available'`
 * rows regardless of age — those may be legitimate secondary accounts that
 * simply haven't been leased yet, and this repo has no query-time signal to
 * distinguish "idle backup account" from "not-yet-marked-dead rotation
 * orphan" without risking a false-positive delete of a real credential.
 */
async function deleteStaleCredentials(
  db: Db,
  cutoff: Date,
): Promise<number> {
  const deleted = await db
    .delete(credentials)
    .where(
      and(
        isNull(credentials.leasedBy),
        lt(credentials.updatedAt, cutoff),
        or(
          eq(credentials.status, "refresh_failed"),
          eq(credentials.isPrimary, false),
        ),
      ),
    );
  return deleted.count;
}

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
 *   - git_events                > 90 days  (add-git-status-orbit)
 *   - credentials        > 30 days   (nx-lp8v/nx-m5q6, conditional — see
 *                                      deleteStaleCredentials())
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
  const gitEventsCutoff = new Date(
    Date.now() - GIT_EVENTS_RETENTION_DAYS * 86_400_000,
  );
  const credentialsCutoff = new Date(
    Date.now() - CREDENTIALS_RETENTION_DAYS * 86_400_000,
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
  const gitEventsDeleted = await db
    .delete(gitEvents)
    .where(lt(gitEvents.createdAt, gitEventsCutoff));
  const credentialsDeleted = await deleteStaleCredentials(
    db,
    credentialsCutoff,
  );

  logger.info({
    health_deleted: healthDeleted.count,
    events_deleted: eventsDeleted.count,
    credential_events_deleted: credentialEventsDeleted.count,
    cron_runs_deleted: cronRunsDeleted.count,
    bloat_radar_deleted: bloatRadarDeleted.count,
    spec_sessions_deleted: specSessionsDeleted.count,
    spec_snapshots_deleted: specSnapshotsDeleted.count,
    project_status_snapshots_deleted: projectStatusSnapshotsDeleted.count,
    git_events_deleted: gitEventsDeleted.count,
    credentials_deleted: credentialsDeleted,
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
