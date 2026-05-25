import type { HealthMetrics } from "@nexus/core";
import type { Db } from "@nexus/db";
import type { HealthCollector } from "./health-collector";
import { insertHealthSnapshot } from "./db/health";
import { getAgentId, logger } from "@nexus/core/node";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Aggregate the per-disk percent array into the single `disk_percent` summary
 * column. Returns `null` when there are no disks.
 *
 * The aggregate is a capacity-weighted average (by `total_bytes`) so the
 * largest mount dominates the headline figure. When every mount reports a
 * `total_bytes` of 0 (an edge case for degraded / pseudo filesystems), it
 * falls back to an UNWEIGHTED average across ALL disks rather than dropping
 * disks 1..n by taking only `disk[0]` — multi-disk machines are never reduced
 * to a single disk's value. The complete per-disk array is always preserved
 * separately in the snapshot's `rawJson` field.
 */
export function aggregateDiskPercent(
  disk: HealthMetrics["disk"],
): number | null {
  if (disk.length === 0) return null;
  const totalBytes = disk.reduce((sum, d) => sum + d.total_bytes, 0);
  const weighted =
    totalBytes > 0
      ? disk.reduce((sum, d) => sum + (d.percent * d.total_bytes) / totalBytes, 0)
      : disk.reduce((sum, d) => sum + d.percent, 0) / disk.length;
  return Math.round(weighted * 10) / 10;
}

/**
 * Periodically collects health metrics and persists them to the
 * health_snapshots table for time-series queries.
 */
export class HealthScheduler {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private collector: HealthCollector;
  private db: Db;

  constructor(
    collector: HealthCollector,
    db: Db,
    intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {
    this.collector = collector;
    this.db = db;
    this.intervalMs = intervalMs;
  }

  /** Start periodic snapshot collection. First snapshot is taken immediately. */
  start(): void {
    safeFireAndForget(this.tick(), "health-scheduler-tick");
    this.timer = setInterval(() => safeFireAndForget(this.tick(), "health-scheduler-tick"), this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, "health scheduler started");
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("health scheduler stopped");
    }
  }

  /** Run a single collection + persist cycle. */
  private async tick(): Promise<void> {
    const metrics = this.collector.getLatest();
    if (metrics === null) {
      logger.debug("health scheduler tick skipped — collector not yet warmed up");
      return;
    }

    // `diskPercent` is a single-column summary; the FULL per-disk array is
    // retained in `rawJson` below (no schema change needed for multi-disk
    // capture). The summary aggregates across ALL mounts — it never reduces to
    // a single disk, so multi-disk machines are represented fairly in the fast
    // time-series column while every disk's detail survives in `rawJson`.
    const diskPercent = aggregateDiskPercent(metrics.disk);

    const childLogger = logger.child({
      component: "health-scheduler",
      hostname: metrics.hostname,
      diskPercent,
      // Per-disk detail so multi-disk machines are observable in logs, not
      // just collapsed into the aggregate.
      diskCount: metrics.disk.length,
      diskMounts: metrics.disk.map((d) => d.mount),
      cpuPercent: metrics.cpu.overall_percent,
    });

    const snapshot = {
      timestamp: new Date(),
      // Agent identity matches `upsertSelfInRegistry` — resolved via
      // agents.toml (self_name) with os.hostname() fallback.
      agentId: getAgentId(),
      cpuPercent: metrics.cpu.overall_percent,
      ramPercent: metrics.ram.percent,
      diskPercent,
      dockerContainers: metrics.docker?.containers ?? null,
      // Serializes the complete metrics payload, including the full
      // `metrics.disk[]` array — this is where all disks (1..n) are retained.
      rawJson: JSON.stringify(metrics),
    };

    const BASE_MS = 1_000;
    const MAX_MS = 60_000;
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await insertHealthSnapshot(this.db, snapshot);
        return;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS - 1) {
          const jitter = Math.random() * 200;
          const delay = Math.min(BASE_MS * 2 ** attempt + jitter, MAX_MS);
          childLogger.warn({ err, attempt, nextDelayMs: Math.round(delay) }, "health snapshot insert failed, retrying");
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          childLogger.error({ err }, "health snapshot insert failed after all retries");
        }
      }
    }
  }
}
