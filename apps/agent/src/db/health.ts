import type { Db } from "@nexus/db";
import { healthSnapshots } from "@nexus/db";
import { gte, asc } from "drizzle-orm";

/** Row shape returned from the `health_snapshots` table. */
export type HealthSnapshotRow = typeof healthSnapshots.$inferSelect;

/** Insert value shape (no `id` — it's auto-generated). */
type HealthSnapshotInsert = typeof healthSnapshots.$inferInsert;

/** Insert a new health snapshot. */
export async function insertHealthSnapshot(
  db: Db,
  snapshot: Omit<HealthSnapshotInsert, "id">,
): Promise<void> {
  await db.insert(healthSnapshots).values(snapshot);
}

/**
 * Query health snapshots for the last `hours` hours, ordered by timestamp
 * ascending (sparkline-ready).
 */
export async function queryHealthTimeSeries(
  db: Db,
  hours: number = 24,
): Promise<HealthSnapshotRow[]> {
  const cutoff = new Date(Date.now() - hours * 3600_000);
  return db
    .select()
    .from(healthSnapshots)
    .where(gte(healthSnapshots.timestamp, cutoff))
    .orderBy(asc(healthSnapshots.timestamp));
}
