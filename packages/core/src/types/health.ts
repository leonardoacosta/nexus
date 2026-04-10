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
}

/** A single process entry for the top-N CPU/RAM lists. */
export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  ram_percent: number;
}
