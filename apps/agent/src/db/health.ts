import type { Db } from "@nexus/db";
import { healthSnapshots } from "@nexus/db";
import { gte, asc, sql } from "drizzle-orm";

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
 * Liveness ping — issues `select 1` against the Drizzle pool with a bounded
 * timeout. Returns `true` on success, `false` on any failure (timeout,
 * refused connection, dead pool, syntax error — the caller doesn't care
 * which; the point is whether the pool can answer a trivial query).
 *
 * Used by `GET /health.db_ok` so a dashboard can distinguish "agent up,
 * PG down" from "agent down".
 */
export async function pingDb(db: Db, timeoutMs: number = 1000): Promise<boolean> {
  try {
    const queryPromise = db.execute(sql`select 1`).then(() => true);
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([queryPromise, timeoutPromise]);
  } catch {
    return false;
  }
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
