import type { HealthMetrics, ProcessInfo } from "@nexus/core";
import { logger } from "@nexus/core";
import si from "systeminformation";
import os from "node:os";

const DEFAULT_INTERVAL_MS = 5_000;

export class HealthCollector {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: HealthMetrics | null = null;

  constructor(intervalMs: number = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /** Start periodic collection. First collection happens immediately. */
  start(): void {
    // Collect immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  /** Stop periodic collection. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Return the most recently collected metrics, or null if none yet. */
  getLatest(): HealthMetrics | null {
    return this.latest;
  }

  /** Run a single collection cycle. */
  async collect(): Promise<HealthMetrics> {
    const [cpuLoad, mem, disks, dockerContainers, netStats, procs] =
      await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        this.collectDocker(),
        si.networkStats(),
        si.processes(),
      ]);

    const collectedAt = new Date().toISOString();

    const metrics: HealthMetrics = {
      hostname: os.hostname(),
      uptime_seconds: Math.floor(os.uptime()),
      collectedAt,
      cpu: {
        overall_percent: round(cpuLoad.currentLoad),
        per_core_percent: cpuLoad.cpus.map((c) => round(c.load)),
        load_average: os.loadavg(),
      },
      ram: {
        total_bytes: mem.total,
        used_bytes: mem.used,
        percent: round((mem.used / mem.total) * 100),
      },
      disk: disks.map((d) => ({
        mount: d.mount,
        total_bytes: d.size,
        used_bytes: d.used,
        percent: round(d.use),
      })),
      docker: dockerContainers,
      network: netStats.map((n) => ({
        iface: n.iface,
        rx_bytes: n.rx_bytes,
        tx_bytes: n.tx_bytes,
      })),
      processes: {
        top_cpu: topN(procs.list, "cpu", 10),
        top_ram: topN(procs.list, "mem", 10),
      },
    };

    return metrics;
  }

  private async tick(): Promise<void> {
    const childLogger = logger.child({ component: "health-collector", hostname: os.hostname(), intervalMs: this.intervalMs });
    try {
      this.latest = await this.collect();
      childLogger.debug({ collectedAt: this.latest.collectedAt }, "health collection tick succeeded");
    } catch (err) {
      childLogger.warn({ err }, "health collection tick failed");
    }
  }

  private async collectDocker(): Promise<{
    containers: number;
    running: number;
  } | null> {
    try {
      const containers = await si.dockerContainers();
      return {
        containers: containers.length,
        running: containers.filter((c) => c.state === "running").length,
      };
    } catch (err) {
      logger.warn({ err }, "docker collection failed");
      return null;
    }
  }
}

/** Round to 1 decimal place. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Extract top N processes sorted by the given field. */
function topN(
  list: si.Systeminformation.ProcessesProcessData[],
  field: "cpu" | "mem",
  n: number,
): ProcessInfo[] {
  return [...list]
    .sort((a, b) => b[field] - a[field])
    .slice(0, n)
    .map((p) => ({
      pid: p.pid,
      name: p.name,
      cpu_percent: round(p.cpu),
      ram_percent: round(p.mem),
    }));
}
