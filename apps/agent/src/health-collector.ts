import type { HealthMetrics, ProcessInfo } from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import si from "systeminformation";
import os from "node:os";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";

const DEFAULT_INTERVAL_MS = 5_000;

// Docker backoff constants
const DOCKER_BACKOFF_INITIAL_MS = 30_000;
const DOCKER_BACKOFF_MAX_MS = 600_000;

/**
 * Named module logger — routes warn/error/fatal to the `script_errors` DB sink
 * (when attached) in addition to stdout, matching the agent's other services
 * (e.g. `cc-credential-manager`). Replaces the previous bare `logger` singleton
 * + ad-hoc `logger.child` usage so collection failures are observable instead
 * of being swallowed inside a coarse `Promise.all`.
 */
const log = createLogger("agent:health-collector");

/**
 * Run a single metric-collection step, logging (but not rethrowing) any
 * failure so one failing source doesn't take down the whole collection cycle.
 * Returns the resolved value on success, or `fallback` on error. The previous
 * `Promise.all` approach rejected the entire tick on any single failure and
 * surfaced no per-step granularity — this makes WHICH source failed visible.
 */
async function collectStep<T>(
  step: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.warn({ err, step }, "health metric-collection step failed");
    return fallback;
  }
}

export class HealthCollector {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: HealthMetrics | null = null;

  // Docker detection exponential backoff state
  private dockerBackoffUntil: number = 0;
  private dockerBackoffMs: number = DOCKER_BACKOFF_INITIAL_MS;

  constructor(intervalMs: number = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /** Start periodic collection. First collection happens immediately. */
  start(): void {
    log.info({ intervalMs: this.intervalMs }, "health collector started");
    // Collect immediately, then on interval
    safeFireAndForget(this.tick(), "health-collector-tick");
    this.timer = setInterval(() => safeFireAndForget(this.tick(), "health-collector-tick"), this.intervalMs);
  }

  /** Stop periodic collection. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("health collector stopped");
    }
  }

  /** Return the most recently collected metrics, or null if none yet. */
  getLatest(): HealthMetrics | null {
    return this.latest;
  }

  /** Run a single collection cycle. */
  async collect(): Promise<HealthMetrics> {
    // Each source is collected in isolation: a single failing source logs a
    // `warn` (which source, with the error) and degrades to a safe fallback
    // instead of rejecting the whole cycle. Each step projects the upstream
    // systeminformation payload down to ONLY the fields the collector reads,
    // so the fallback need not fabricate the full (large) upstream types.
    // `collectDocker` already owns its own backoff + logging.
    const [cpuLoad, mem, disks, dockerContainers, netStats, procs] =
      await Promise.all([
        collectStep(
          "cpu",
          async () => {
            const r = await si.currentLoad();
            return {
              currentLoad: r.currentLoad,
              cpus: r.cpus.map((c) => ({ load: c.load })),
            };
          },
          { currentLoad: 0, cpus: [] as Array<{ load: number }> },
        ),
        collectStep(
          "mem",
          async () => {
            const r = await si.mem();
            return { total: r.total, used: r.used };
          },
          { total: 0, used: 0 },
        ),
        collectStep(
          "disk",
          async () => {
            const r = await si.fsSize();
            return r.map((d) => ({ mount: d.mount, size: d.size, used: d.used, use: d.use }));
          },
          [] as Array<{ mount: string; size: number; used: number; use: number }>,
        ),
        this.collectDocker(),
        collectStep(
          "network",
          async () => {
            const r = await si.networkStats();
            return r.map((n) => ({ iface: n.iface, rx_bytes: n.rx_bytes, tx_bytes: n.tx_bytes }));
          },
          [] as Array<{ iface: string; rx_bytes: number; tx_bytes: number }>,
        ),
        collectStep(
          "processes",
          async () => {
            const r = await si.processes();
            return { list: r.list };
          },
          { list: [] as si.Systeminformation.ProcessesProcessData[] },
        ),
      ]);

    // Surface empty results that usually indicate a degraded source — these
    // were previously invisible because an empty array is not an error.
    if (disks.length === 0) {
      log.warn("disk collection returned no mounts");
    }
    if (cpuLoad.cpus.length === 0) {
      log.warn("cpu collection returned no per-core data");
    }

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
        // Guard against the `total: 0` fallback (failed mem step) producing
        // a NaN percent — a degraded source reports 0%, not NaN.
        percent: mem.total > 0 ? round((mem.used / mem.total) * 100) : 0,
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
      // Liveness fields are populated by handleHealthGet from the
      // server-scoped liveness providers; the collector itself has no
      // visibility into the watcher / socket / DB. Defaults here are safe
      // sentinels and will be overwritten before the response is sent.
      db_ok: false,
      last_watcher_tick_ms: -1,
      socket_server_listening: false,
    };

    return metrics;
  }

  private async tick(): Promise<void> {
    try {
      this.latest = await this.collect();
      log.debug(
        {
          collectedAt: this.latest.collectedAt,
          diskCount: this.latest.disk.length,
        },
        "health collection tick succeeded",
      );
    } catch (err) {
      // `collect()` now isolates each source, so reaching here means an
      // unexpected failure outside the per-step boundaries (e.g. os.* calls).
      log.error({ err }, "health collection tick failed unexpectedly");
    }
  }

  private async collectDocker(): Promise<{
    containers: number;
    running: number;
  } | null> {
    // Skip if we are within a backoff window (Docker unavailable or erroring)
    if (Date.now() < this.dockerBackoffUntil) {
      return null;
    }

    try {
      const containers = await si.dockerContainers();
      // Success: reset backoff
      this.dockerBackoffMs = DOCKER_BACKOFF_INITIAL_MS;
      this.dockerBackoffUntil = 0;
      return {
        containers: containers.length,
        running: containers.filter((c) => c.state === "running").length,
      };
    } catch (err) {
      // Failure: double the backoff interval (cap at max) and set next check time
      this.dockerBackoffMs = Math.min(this.dockerBackoffMs * 2, DOCKER_BACKOFF_MAX_MS);
      this.dockerBackoffUntil = Date.now() + this.dockerBackoffMs;
      log.warn(
        { err, nextCheckMs: this.dockerBackoffMs },
        "docker collection failed — applying backoff",
      );
      return null;
    }
  }
}

/** Round to 1 decimal place. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Max length of the `command` field before truncation (with `…` suffix). */
const COMMAND_MAX_LENGTH = 200;

/**
 * Truncate a command string to 200 chars + trailing ellipsis (`…`). The
 * resulting length is exactly 201 characters when truncation kicks in.
 * Returns null when the input is null / undefined / empty.
 */
function truncateCommand(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length <= COMMAND_MAX_LENGTH) return raw;
  return raw.slice(0, COMMAND_MAX_LENGTH) + "…";
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
    .map((p) => {
      // systeminformation's ProcessesProcessData carries optional
      // `command`, `user`, and `state` fields that aren't in the strict
      // public type on older releases. Read them with `unknown`-typed
      // bracket access so missing fields degrade to `null` rather than
      // crashing the collector.
      const row = p as unknown as Record<string, unknown>;
      const userRaw = row.user;
      const stateRaw = row.state;
      return {
        pid: p.pid,
        name: p.name,
        cpu_percent: round(p.cpu),
        ram_percent: round(p.mem),
        command: truncateCommand(row.command),
        user: typeof userRaw === "string" && userRaw.length > 0 ? userRaw : null,
        state: typeof stateRaw === "string" && stateRaw.length > 0 ? stateRaw : null,
      };
    });
}
