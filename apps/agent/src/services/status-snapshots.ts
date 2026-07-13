/**
 * Change-only status-snapshot writer.
 *
 * Turns recomputed totals into Postgres time-series rows, inserting ONLY when
 * a value actually changed vs the latest persisted row — never on every tick.
 * That keeps `spec_snapshots` and `project_status_snapshots` small (trend
 * tables, not per-tick timeseries) and makes the change comparison double as
 * the BeadTransition emission gate.
 *
 * Two source paths feed the per-project row, each owning a subset of columns:
 *   - spec-watcher tick  -> `proposals_unarchived` (live spec count) + per-spec
 *     `spec_snapshots`. Carries the latest bead counts forward unchanged.
 *   - beads-watcher recount -> `beads_ready_unlinked` / `beads_blocked_unlinked`.
 *     Carries the latest `proposals_unarchived` forward unchanged, and emits a
 *     `BeadTransition` when (and only when) the bead counts moved.
 *
 * Comparing against the DB latest row (not in-memory state) is what makes this
 * restart-safe: after a restart the first recompute compares against the last
 * persisted row and skips a duplicate insert.
 *
 * Spec: openspec/changes/add-project-status-snapshots/ (spec-timeseries delta).
 */

import type { Db } from "@nexus/db";
import { projectStatusSnapshots, specSnapshots } from "@nexus/db";
import { and, desc, eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import type { BeadUnlinkedCounts } from "@nexus/core";
import { lifecycleBus } from "./lifecycle-bus";

const log = createLogger("agent:services:status-snapshots");

// ---------------------------------------------------------------------------
// Per-spec snapshots (spec_snapshots)
// ---------------------------------------------------------------------------

/**
 * Insert a `spec_snapshots` row for `(project, specName)` only when the
 * completed/total task counts differ from the latest persisted row (or there
 * is none yet). Returns `true` when a row was inserted.
 */
export async function recordSpecSnapshot(
  db: Db,
  project: string,
  specName: string,
  completed: number,
  total: number,
): Promise<boolean> {
  const [latest] = await db
    .select()
    .from(specSnapshots)
    .where(
      and(
        eq(specSnapshots.project, project),
        eq(specSnapshots.specName, specName),
      ),
    )
    .orderBy(desc(specSnapshots.createdAt))
    .limit(1);

  if (latest && latest.completed === completed && latest.total === total) {
    return false;
  }

  await db.insert(specSnapshots).values({ project, specName, completed, total });
  return true;
}

// ---------------------------------------------------------------------------
// Per-project snapshots (project_status_snapshots)
// ---------------------------------------------------------------------------

interface LatestProjectStatus {
  proposalsUnarchived: number;
  beadsReadyUnlinked: number;
  beadsBlockedUnlinked: number;
}

/** Latest `project_status_snapshots` row for a project, or `null`. */
async function latestProjectStatus(
  db: Db,
  project: string,
): Promise<LatestProjectStatus | null> {
  const [row] = await db
    .select()
    .from(projectStatusSnapshots)
    .where(eq(projectStatusSnapshots.project, project))
    .orderBy(desc(projectStatusSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Record a per-project snapshot from the beads-watcher recount.
 *
 * Reads the latest row to carry `proposals_unarchived` forward, compares the
 * bead counts, and — only when they changed — inserts a new row AND emits a
 * `BeadTransition` (previous vs current bead counts). A first observation with
 * all-zero counts is a no-op (no baseline noise); the previous counts default
 * to `{0, 0}` when no row exists yet.
 */
export async function recordProjectStatusFromBeads(
  db: Db,
  project: string,
  counts: BeadUnlinkedCounts,
): Promise<boolean> {
  const latest = await latestProjectStatus(db, project);
  const prevReady = latest?.beadsReadyUnlinked ?? 0;
  const prevBlocked = latest?.beadsBlockedUnlinked ?? 0;

  const changed =
    prevReady !== counts.beadsReadyUnlinked ||
    prevBlocked !== counts.beadsBlockedUnlinked;
  if (!changed) return false;

  await db.insert(projectStatusSnapshots).values({
    project,
    proposalsUnarchived: latest?.proposalsUnarchived ?? 0,
    beadsReadyUnlinked: counts.beadsReadyUnlinked,
    beadsBlockedUnlinked: counts.beadsBlockedUnlinked,
  });

  lifecycleBus.emit("BeadTransition", {
    project,
    previous: { beadsReadyUnlinked: prevReady, beadsBlockedUnlinked: prevBlocked },
    current: counts,
    at: new Date().toISOString(),
  });

  log.debug({ project, counts }, "status-snapshots: bead counts changed");
  return true;
}

/**
 * Record a per-project snapshot from the spec-watcher tick.
 *
 * Reads the latest row to carry the bead counts forward, and inserts a new row
 * only when `proposals_unarchived` changed. Never emits a `BeadTransition`
 * (bead counts are unchanged on a spec-only recount).
 */
export async function recordProjectStatusFromSpecs(
  db: Db,
  project: string,
  proposalsUnarchived: number,
): Promise<boolean> {
  const latest = await latestProjectStatus(db, project);
  const prevProposals = latest?.proposalsUnarchived ?? 0;
  if (latest && prevProposals === proposalsUnarchived) return false;
  // First observation with zero proposals is a no-op baseline.
  if (!latest && proposalsUnarchived === 0) return false;

  await db.insert(projectStatusSnapshots).values({
    project,
    proposalsUnarchived,
    beadsReadyUnlinked: latest?.beadsReadyUnlinked ?? 0,
    beadsBlockedUnlinked: latest?.beadsBlockedUnlinked ?? 0,
  });
  return true;
}

/**
 * Record all snapshots produced by one spec-watcher project tick: a per-spec
 * `spec_snapshots` row per spec, plus the per-project `proposals_unarchived`
 * aggregate. `proposals_unarchived` is the count of live (unarchived) specs.
 *
 * Best-effort: individual failures are logged, never thrown — the spec-watcher
 * tick must not be aborted by a snapshot write.
 */
export async function recordSpecTickSnapshots(
  db: Db,
  project: string,
  specs: ReadonlyArray<{
    name: string;
    completedTasks: number;
    totalTasks: number;
  }>,
): Promise<void> {
  for (const spec of specs) {
    try {
      await recordSpecSnapshot(
        db,
        project,
        spec.name,
        spec.completedTasks,
        spec.totalTasks,
      );
    } catch (err) {
      log.warn({ project, spec: spec.name, err }, "spec snapshot write failed");
    }
  }

  try {
    await recordProjectStatusFromSpecs(db, project, specs.length);
  } catch (err) {
    log.warn({ project, err }, "project-status (specs) write failed");
  }
}
