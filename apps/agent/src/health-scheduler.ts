import type { Db } from "@nexus/db";
import type { HealthCollector } from "./health-collector";
import { insertHealthSnapshot } from "./db/health";
import { getAgentId, logger } from "@nexus/core";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

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

    // Weighted-average disk percent across all mounts (by total_bytes).
    // Falls back to null if there are no disk entries.
    let diskPercent: number | null = null;
    if (metrics.disk.length > 0) {
      const totalBytes = metrics.disk.reduce((sum, d) => sum + d.total_bytes, 0);
      if (totalBytes > 0) {
        diskPercent = metrics.disk.reduce(
          (sum, d) => sum + (d.percent * d.total_bytes) / totalBytes,
          0,
        );
        diskPercent = Math.round(diskPercent * 10) / 10;
      } else {
        diskPercent = metrics.disk[0]?.percent ?? null;
      }
    }

    const childLogger = logger.child({
      component: "health-scheduler",
      hostname: metrics.hostname,
      diskPercent,
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
