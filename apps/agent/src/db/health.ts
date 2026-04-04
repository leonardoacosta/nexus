import type { Database } from "bun:sqlite";

/** Row shape stored in the `health_snapshots` table. */
export interface HealthSnapshotRow {
  id?: number;
  timestamp: string;
  cpu_percent: number | null;
  ram_percent: number | null;
  disk_percent: number | null;
  docker_containers: number | null;
  raw_json: string | null;
}

/** Insert a new health snapshot. */
export function insertHealthSnapshot(
  db: Database,
  snapshot: Omit<HealthSnapshotRow, "id">,
): void {
  db.query(
    `INSERT INTO health_snapshots (timestamp, cpu_percent, ram_percent, disk_percent, docker_containers, raw_json)
     VALUES ($timestamp, $cpu_percent, $ram_percent, $disk_percent, $docker_containers, $raw_json)`,
  ).run({
    $timestamp: snapshot.timestamp,
    $cpu_percent: snapshot.cpu_percent,
    $ram_percent: snapshot.ram_percent,
    $disk_percent: snapshot.disk_percent,
    $docker_containers: snapshot.docker_containers,
    $raw_json: snapshot.raw_json,
  });
}

/**
 * Query health snapshots for the last `hours` hours, ordered by timestamp
 * ascending (sparkline-ready).
 */
export function queryHealthTimeSeries(
  db: Database,
  hours: number = 24,
): HealthSnapshotRow[] {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  return db
    .query(
      `SELECT * FROM health_snapshots WHERE timestamp >= $cutoff ORDER BY timestamp ASC`,
    )
    .all({ $cutoff: cutoff }) as HealthSnapshotRow[];
}
