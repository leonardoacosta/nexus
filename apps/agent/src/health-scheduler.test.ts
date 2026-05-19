import { describe, expect, it, mock, beforeEach } from "bun:test";

// ── 9.1 Disk weighted-average calculation ─────────────────────────────────────

/**
 * Pure helper extracted from health-scheduler tick() logic.
 * Computes the weighted-average disk percent across all mounts by total_bytes.
 */
function computeDiskPercent(
  disk: Array<{ total_bytes: number; percent: number }>,
): number | null {
  if (disk.length === 0) return null;
  const totalBytes = disk.reduce((s, d) => s + d.total_bytes, 0);
  if (totalBytes === 0) return disk[0]?.percent ?? null;
  const weighted = disk.reduce(
    (s, d) => s + (d.percent * d.total_bytes) / totalBytes,
    0,
  );
  return Math.round(weighted * 10) / 10;
}

describe("health-scheduler: disk weighted-average calculation (task 9.1)", () => {
  it("returns null for empty disk array", () => {
    expect(computeDiskPercent([])).toBeNull();
  });

  it("returns the sole percent for a single disk", () => {
    expect(computeDiskPercent([{ total_bytes: 500_000, percent: 60 }])).toBe(60);
  });

  it("weights by total_bytes — large disk dominates", () => {
    // 100 GB at 80% + 10 GB at 10% → weighted avg ≈ 73.6%
    const disks = [
      { total_bytes: 100_000_000_000, percent: 80 },
      { total_bytes: 10_000_000_000, percent: 10 },
    ];
    const result = computeDiskPercent(disks);
    // Expected: (80*100 + 10*10) / 110 = 8100/110 ≈ 73.6
    expect(result).toBe(73.6);
  });

  it("equal-size disks produce arithmetic average", () => {
    const disks = [
      { total_bytes: 100_000, percent: 40 },
      { total_bytes: 100_000, percent: 60 },
    ];
    expect(computeDiskPercent(disks)).toBe(50);
  });

  it("returns disk[0].percent when all total_bytes are 0", () => {
    const disks = [
      { total_bytes: 0, percent: 55 },
      { total_bytes: 0, percent: 75 },
    ];
    expect(computeDiskPercent(disks)).toBe(55);
  });
});

// ── 9.2 Exponential backoff helper ────────────────────────────────────────────

/**
 * Pure backoff delay function matching the scheduler implementation.
 * Returns delay in ms for a given attempt (0-indexed).
 */
function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  const jitter = Math.random() * 200;
  return Math.min(baseMs * 2 ** attempt + jitter, maxMs);
}

describe("health-scheduler: exponential backoff delays (task 9.2)", () => {
  it("attempt 0 delay is in [base, base+jitter_max]", () => {
    for (let i = 0; i < 20; i++) {
      const d = backoffDelay(0);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(1_200);
    }
  });

  it("attempt 1 delay is in [2*base, 2*base+jitter_max]", () => {
    for (let i = 0; i < 20; i++) {
      const d = backoffDelay(1);
      expect(d).toBeGreaterThanOrEqual(2_000);
      expect(d).toBeLessThanOrEqual(2_200);
    }
  });

  it("delay is capped at maxMs", () => {
    // attempt 10 → 1000 * 1024 = 1_024_000 ms >> maxMs
    for (let i = 0; i < 20; i++) {
      const d = backoffDelay(10, 1_000, 60_000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  it("delays are within [base, max] for all attempts 0..9", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = backoffDelay(attempt);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });
});

// ── 1.3 HealthScheduler uses getLatest() and handles null skip ────────────────

import { HealthScheduler } from "./health-scheduler";
import type { HealthCollector } from "./health-collector";
import type { Db } from "@nexus/db";
import type { HealthMetrics } from "@nexus/core";

/** Create a minimal stub HealthCollector. */
function makeCollectorStub(latestMetrics: HealthMetrics | null): HealthCollector {
  return {
    getLatest: mock(() => latestMetrics),
    collect: mock(() => Promise.resolve(latestMetrics as HealthMetrics)),
    start: mock(() => {}),
    stop: mock(() => {}),
  } as unknown as HealthCollector;
}

/** Minimal db stub with a working insertHealthSnapshot replacement. */
function makeDbStub(): { db: Db; inserts: number } {
  let inserts = 0;
  const db = {} as unknown as Db;
  // We'll patch insertHealthSnapshot via the module mock below
  return { db, inserts: 0 };
}

const insertMock = mock(() => Promise.resolve());
mock.module("./db/health", () => ({
  insertHealthSnapshot: insertMock,
}));

const baseMetrics: HealthMetrics = {
  hostname: "test-host",
  uptime_seconds: 100,
  collectedAt: new Date().toISOString(),
  cpu: { overall_percent: 10, per_core_percent: [10], load_average: [0, 0, 0] },
  ram: { total_bytes: 1000, used_bytes: 500, percent: 50 },
  disk: [{ mount: "/", total_bytes: 1000, used_bytes: 500, percent: 50 }],
  docker: null,
  db_ok: true,
  last_watcher_tick_ms: 0,
  socket_server_listening: true,
};

describe("HealthScheduler.tick() — uses getLatest() (task 1.3)", () => {
  beforeEach(() => {
    insertMock.mockReset();
    insertMock.mockImplementation(() => Promise.resolve());
  });

  it("calls getLatest() (not collect()) on the collector", async () => {
    const collector = makeCollectorStub(baseMetrics);
    const { db } = makeDbStub();
    const scheduler = new HealthScheduler(collector, db, 60_000);

    // Access private tick via type cast
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    expect((collector.getLatest as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((collector.collect as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it("skips insert and returns early when getLatest() returns null", async () => {
    const collector = makeCollectorStub(null);
    const { db } = makeDbStub();
    const scheduler = new HealthScheduler(collector, db, 60_000);

    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    // insertHealthSnapshot should NOT have been called
    expect(insertMock.mock.calls.length).toBe(0);
  });

  it("inserts a snapshot when getLatest() returns metrics", async () => {
    const collector = makeCollectorStub(baseMetrics);
    const { db } = makeDbStub();
    const scheduler = new HealthScheduler(collector, db, 60_000);

    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    expect(insertMock.mock.calls.length).toBe(1);
  });
});
