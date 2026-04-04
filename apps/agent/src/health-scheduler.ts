import type { Db } from "@nexus/db";
import type { HealthCollector } from "./health-collector";
import { insertHealthSnapshot } from "./db/health";
import { logger } from "@nexus/core";

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
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
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
    try {
      const metrics = await this.collector.collect();

      // Use the first disk entry's percent as the aggregate disk_percent
      const diskPercent =
        metrics.disk.length > 0 ? (metrics.disk[0]?.percent ?? null) : null;

      await insertHealthSnapshot(this.db, {
        timestamp: new Date().toISOString(),
        cpuPercent: metrics.cpu.overall_percent,
        ramPercent: metrics.ram.percent,
        diskPercent,
        dockerContainers: metrics.docker?.containers ?? null,
        rawJson: JSON.stringify(metrics),
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "health scheduler tick failed");
    }
  }
}
