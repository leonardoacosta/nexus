/**
 * Memory-pressure monitor (harden-agent-reliability, nx-t9wlb).
 *
 * nexus-agent crashed 3x (SIGABRT/SIGILL) in ~2min under heavy concurrent
 * session load with memory pinned near its systemd `MemoryMax` cap — no kernel
 * OOM-kill was logged, leaving the crash undiagnosable. This monitor gives the
 * next investigation a trail: it periodically reads the process's own cgroup v2
 * memory usage against its limit and emits a structured WARN line whenever
 * usage crosses a high-water threshold (90% of `MemoryMax` by default).
 *
 * Scope is diagnosability only — it does not attempt to prevent or recover from
 * the crash (the exact native-level trigger is still unconfirmed).
 *
 * Fail-soft everywhere: on a non-Linux host, an unbounded cgroup (`memory.max`
 * == "max"), or any read error, the monitor is a silent no-op rather than a
 * source of noise or a startup failure.
 */

import { readFileSync } from "node:fs";
import { createLogger, type Logger } from "@nexus/core/node";

const log = createLogger("agent:memory-pressure");

/** Fraction of `MemoryMax` at/above which a WARN line is emitted. */
export const MEMORY_PRESSURE_THRESHOLD = 0.9;

/** How often the cgroup memory files are sampled. */
const DEFAULT_INTERVAL_MS = 30_000;

/** A single cgroup memory sample. `maxBytes` is null when the cap is unbounded. */
export interface MemoryReading {
  currentBytes: number;
  maxBytes: number | null;
}

/** Reads the current cgroup memory usage + limit. Returns null when unavailable. */
export type MemoryReader = () => MemoryReading | null;

/**
 * Read this process's cgroup v2 memory usage (`memory.current`) and limit
 * (`memory.max`) from the cgroup filesystem.
 *
 * Resolves the leaf cgroup path from `/proc/self/cgroup` (the cgroup v2 line is
 * `0::/user.slice/.../nexus-agent.service`) and reads the two files under
 * `/sys/fs/cgroup`. Returns null on any failure — a missing file (cgroup v1,
 * non-Linux), an unbounded `memory.max` ("max"), or an unparseable value — so
 * the caller treats memory pressure as simply unknown.
 */
export function readCgroupMemory(): MemoryReading | null {
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    // cgroup v2 emits exactly one line: `0::<path>`.
    const v2 = cgroup.split("\n").find((l) => l.startsWith("0::"));
    if (!v2) return null;
    const relPath = v2.slice("0::".length).trim();
    const base = `/sys/fs/cgroup${relPath === "/" ? "" : relPath}`;

    const rawCurrent = readFileSync(`${base}/memory.current`, "utf8").trim();
    const rawMax = readFileSync(`${base}/memory.max`, "utf8").trim();

    const currentBytes = Number.parseInt(rawCurrent, 10);
    if (!Number.isFinite(currentBytes)) return null;

    // "max" means no limit set — pressure against a cap is undefined.
    const maxBytes = rawMax === "max" ? null : Number.parseInt(rawMax, 10);
    if (maxBytes !== null && !Number.isFinite(maxBytes)) return null;

    return { currentBytes, maxBytes };
  } catch {
    return null;
  }
}

/**
 * Compute the memory-pressure ratio for a reading. Returns null when there is
 * no bounded limit to measure against (unbounded or non-positive `maxBytes`).
 */
export function evaluateMemoryPressure(
  reading: MemoryReading,
  threshold: number = MEMORY_PRESSURE_THRESHOLD,
): { ratio: number; pressured: boolean } | null {
  if (reading.maxBytes === null || reading.maxBytes <= 0) return null;
  const ratio = reading.currentBytes / reading.maxBytes;
  return { ratio, pressured: ratio >= threshold };
}

/**
 * Sample memory once and emit a structured WARN line if usage is at/above the
 * threshold. Exported so tests can drive a single deterministic tick with an
 * injected reader instead of waiting on the interval.
 *
 * Returns true iff a pressure warning was emitted this tick.
 */
export function checkMemoryPressureOnce(
  read: MemoryReader,
  threshold: number = MEMORY_PRESSURE_THRESHOLD,
  logger: Logger = log,
): boolean {
  const reading = read();
  if (!reading) return false;
  const result = evaluateMemoryPressure(reading, threshold);
  if (!result || !result.pressured) return false;
  logger.warn(
    {
      currentBytes: reading.currentBytes,
      maxBytes: reading.maxBytes,
      usedPercent: Math.round(result.ratio * 1000) / 10,
      thresholdPercent: Math.round(threshold * 1000) / 10,
    },
    "memory pressure: agent cgroup usage crossed threshold of MemoryMax",
  );
  return true;
}

/**
 * Start the periodic memory-pressure monitor. Returns a stop function.
 *
 * The reader, interval, and threshold are all injectable for testing. A first
 * sample is taken immediately so a process that starts already-pressured is
 * flagged without waiting a full interval.
 */
export function startMemoryPressureMonitor(opts?: {
  intervalMs?: number;
  read?: MemoryReader;
  threshold?: number;
}): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const read = opts?.read ?? readCgroupMemory;
  const threshold = opts?.threshold ?? MEMORY_PRESSURE_THRESHOLD;

  checkMemoryPressureOnce(read, threshold);
  const timer = setInterval(() => {
    checkMemoryPressureOnce(read, threshold);
  }, intervalMs);
  // Don't keep the event loop alive solely for this diagnostic sampler.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return () => clearInterval(timer);
}
