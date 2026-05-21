/**
 * Domain-level HealthMetrics types for the Nexus application layer.
 *
 * These types use JSON-friendly representations that match the REST/JSON
 * transport between the Bun agent and Next.js dashboard.
 */

/** System health metrics collected from a machine. */
export interface HealthMetrics {
  hostname: string;
  uptime_seconds: number;
  /** ISO-8601 timestamp set when collect() successfully completes. */
  collectedAt?: string;
  cpu: {
    overall_percent: number;
    per_core_percent: number[];
    load_average: number[];
  };
  ram: {
    total_bytes: number;
    used_bytes: number;
    percent: number;
  };
  disk: Array<{
    mount: string;
    total_bytes: number;
    used_bytes: number;
    percent: number;
  }>;
  docker: { containers: number; running: number } | null;
  network?: Array<{
    iface: string;
    rx_bytes: number;
    tx_bytes: number;
  }>;
  processes?: {
    top_cpu: ProcessInfo[];
    top_ram: ProcessInfo[];
  };
  /**
   * Liveness — Drizzle pool can issue a trivial `select 1`. False on a dead
   * pool / timeout / refused connection. Endpoint stays 200 either way.
   */
  db_ok: boolean;
  /**
   * Liveness — monotonic ms since the process-watcher's `reconcileOnce()`
   * last completed. Sentinel `-1` means the watcher has not ticked yet
   * (e.g. agent just booted, or watcher disabled because PG is absent).
   */
  last_watcher_tick_ms: number;
  /**
   * Liveness — UNIX socket spine is bound and accepting. False when the
   * server failed to bind (path conflict, permission denied) or has been
   * stopped.
   */
  socket_server_listening: boolean;
}

/** A single process entry for the top-N CPU/RAM lists. */
export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  ram_percent: number;
  /**
   * Full command-line as reported by `systeminformation`. Truncated at 200
   * characters with a trailing ellipsis (`…`) when the upstream value
   * exceeds that length. Optional / nullable so older agents that omit the
   * field continue to decode on the Swift side.
   */
  command?: string | null;
  /**
   * Process owner — username on macOS, numeric uid on Linux. Best-effort
   * passthrough; the UI is responsible for any cosmetic prefixing of
   * numeric uids (e.g. `uid:1000`).
   */
  user?: string | null;
  /**
   * Kernel state string. Linux returns R/S/D/Z/I; macOS may return
   * `running` / `sleeping` / etc. Passed through as-is — cross-platform
   * normalisation is out of scope.
   */
  state?: string | null;
}

/** Response payload for `GET /health/processes`. */
export interface HealthProcessesResponse {
  top_cpu: ProcessInfo[];
  top_ram: ProcessInfo[];
  /** ISO-8601 timestamp of the collector tick. Null while warming up. */
  collectedAt: string | null;
}
