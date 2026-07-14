/**
 * Memory-pressure monitor tests (harden-agent-reliability, nx-t9wlb / task 4.1).
 *
 * Verifies that a structured WARN line is emitted under simulated high-memory
 * load, and that the fail-soft branches (unbounded cap, below threshold, null
 * reading) stay silent. Drives `checkMemoryPressureOnce` with an injected
 * reader + a capturing logger — no real cgroup files touched.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Logger } from "@nexus/core/node";
import {
  checkMemoryPressureOnce,
  evaluateMemoryPressure,
  MEMORY_PRESSURE_THRESHOLD,
  type MemoryReading,
} from "./memory-pressure";

/** A logger stub that records every `warn(obj, msg)` call. */
function makeLoggerStub(): {
  logger: Logger;
  warnCalls: Array<[Record<string, unknown>, string]>;
} {
  const warnCalls: Array<[Record<string, unknown>, string]> = [];
  const logger = {
    warn: mock((obj: Record<string, unknown>, msg: string) => {
      warnCalls.push([obj, msg]);
    }),
    info: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
  return { logger, warnCalls };
}

describe("checkMemoryPressureOnce", () => {
  it("emits a structured WARN line when usage is at/above 90% of MemoryMax", () => {
    const { logger, warnCalls } = makeLoggerStub();
    // 95% of the cap → pressured.
    const read = () => ({ currentBytes: 95, maxBytes: 100 }) as MemoryReading;

    const emitted = checkMemoryPressureOnce(read, MEMORY_PRESSURE_THRESHOLD, logger);

    expect(emitted).toBe(true);
    expect(warnCalls).toHaveLength(1);
    const [fields, msg] = warnCalls[0]!;
    expect(msg).toContain("memory pressure");
    expect(fields.currentBytes).toBe(95);
    expect(fields.maxBytes).toBe(100);
    expect(fields.usedPercent).toBe(95);
    expect(fields.thresholdPercent).toBe(90);
  });

  it("stays silent when usage is below the threshold", () => {
    const { logger, warnCalls } = makeLoggerStub();
    const read = () => ({ currentBytes: 50, maxBytes: 100 }) as MemoryReading;

    const emitted = checkMemoryPressureOnce(read, MEMORY_PRESSURE_THRESHOLD, logger);

    expect(emitted).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("stays silent (no crash) when the cap is unbounded (maxBytes null)", () => {
    const { logger, warnCalls } = makeLoggerStub();
    const read = () => ({ currentBytes: 9_999, maxBytes: null }) as MemoryReading;

    expect(checkMemoryPressureOnce(read, MEMORY_PRESSURE_THRESHOLD, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("stays silent when the reader returns null (unavailable)", () => {
    const { logger, warnCalls } = makeLoggerStub();
    const read = () => null;

    expect(checkMemoryPressureOnce(read, MEMORY_PRESSURE_THRESHOLD, logger)).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });
});

describe("evaluateMemoryPressure", () => {
  it("returns null for an unbounded cap", () => {
    expect(evaluateMemoryPressure({ currentBytes: 100, maxBytes: null })).toBeNull();
  });

  it("flags pressured at exactly the threshold (>=)", () => {
    const r = evaluateMemoryPressure({ currentBytes: 90, maxBytes: 100 });
    expect(r?.pressured).toBe(true);
    expect(r?.ratio).toBe(0.9);
  });
});
