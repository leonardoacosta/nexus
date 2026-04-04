import type { Database } from "bun:sqlite";
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
  private db: Database;

  constructor(
    collector: HealthCollector,
    db: Database,
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
    logger.info("health scheduler started", { intervalMs: this.intervalMs });
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

      insertHealthSnapshot(this.db, {
        timestamp: new Date().toISOString(),
        cpu_percent: metrics.cpu.overall_percent,
        ram_percent: metrics.ram.percent,
        disk_percent: diskPercent,
        docker_containers: metrics.docker?.containers ?? null,
        raw_json: JSON.stringify(metrics),
      });
    } catch (err) {
      logger.error("health scheduler tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
