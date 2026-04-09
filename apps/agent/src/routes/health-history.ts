import type { Db } from "@nexus/db";
import { queryHealthTimeSeries } from "../db/health";
import type { HealthSnapshotRow } from "../db/health";

/** Max data points before downsampling kicks in. */
const MAX_POINTS = 200;

/** Sparkline-ready data point returned by the API. */
export interface HealthHistoryPoint {
  timestamp: Date | string;
  cpu_percent: number | null;
  ram_percent: number | null;
  disk_percent: number | null;
}

/**
 * Downsample an array of snapshot rows by splitting into `targetCount` buckets
 * and averaging each bucket's numeric values. The timestamp used for each
 * bucket is the first timestamp in that bucket.
 */
export function downsample(
  rows: HealthSnapshotRow[],
  targetCount: number,
): HealthHistoryPoint[] {
  if (rows.length <= targetCount) {
    return rows.map(toPoint);
  }

  const bucketSize = rows.length / targetCount;
  const result: HealthHistoryPoint[] = [];

  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    const bucket = rows.slice(start, end);

    if (bucket.length === 0) continue;

    let cpuSum = 0,
      cpuCount = 0;
    let ramSum = 0,
      ramCount = 0;
    let diskSum = 0,
      diskCount = 0;

    for (const row of bucket) {
      if (row.cpuPercent !== null) {
        cpuSum += row.cpuPercent;
        cpuCount++;
      }
      if (row.ramPercent !== null) {
        ramSum += row.ramPercent;
        ramCount++;
      }
      if (row.diskPercent !== null) {
        diskSum += row.diskPercent;
        diskCount++;
      }
    }

    result.push({
      timestamp: bucket[0]!.timestamp,
      cpu_percent: cpuCount > 0 ? round(cpuSum / cpuCount) : null,
      ram_percent: ramCount > 0 ? round(ramSum / ramCount) : null,
      disk_percent: diskCount > 0 ? round(diskSum / diskCount) : null,
    });
  }

  return result;
}

/** Convert a snapshot row to a sparkline point. */
function toPoint(row: HealthSnapshotRow): HealthHistoryPoint {
  return {
    timestamp: row.timestamp,
    cpu_percent: row.cpuPercent,
    ram_percent: row.ramPercent,
    disk_percent: row.diskPercent,
  };
}

/** Round to 1 decimal place. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * GET /health/history?hours=24
 *
 * Returns a sparkline-ready array of health data points, automatically
 * downsampled when the raw count exceeds MAX_POINTS (200).
 */
export async function handleGetHealthHistory(db: Db, url: URL): Promise<Response> {
  const hoursParam = url.searchParams.get("hours");
  const hours = hoursParam ? Number(hoursParam) : 24;

  if (Number.isNaN(hours) || hours <= 0) {
    return new Response(
      JSON.stringify({ error: "hours must be a positive number" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const rows = await queryHealthTimeSeries(db, hours);

  const points =
    rows.length > MAX_POINTS ? downsample(rows, MAX_POINTS) : rows.map(toPoint);

  return new Response(JSON.stringify(points), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
