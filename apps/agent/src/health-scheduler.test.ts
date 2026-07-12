import { describe, expect, it, mock, beforeEach } from "bun:test";
import { aggregateDiskPercent } from "./health-scheduler";
import type { HealthMetrics } from "@nexus/core";

// ── 9.1 Disk weighted-average calculation (nx-k7xa) ────────────────────────────
//
// Exercises the REAL exported `aggregateDiskPercent`, not a local duplicate —
// a prior version of this file tested a copy-pasted stand-in that had already
// drifted from the real implementation's all-zero-bytes fallback (disk[0]
// vs. unweighted average), so the multi-disk fix was never actually verified.

type Disk = HealthMetrics["disk"][number];

function disk(mount: string, total_bytes: number, percent: number): Disk {
  return { mount, total_bytes, used_bytes: Math.round((total_bytes * percent) / 100), percent };
}

describe("aggregateDiskPercent (task 9.1, nx-k7xa)", () => {
  it("returns null for empty disk array", () => {
    expect(aggregateDiskPercent([])).toBeNull();
  });

  it("returns the sole percent for a single disk", () => {
    expect(aggregateDiskPercent([disk("/", 500_000, 60)])).toBe(60);
  });

  it("weights by total_bytes — large disk dominates", () => {
    // 100 GB at 80% + 10 GB at 10% → weighted avg ≈ 73.6%
    const disks = [disk("/", 100_000_000_000, 80), disk("/data", 10_000_000_000, 10)];
    // Expected: (80*100 + 10*10) / 110 = 8100/110 ≈ 73.6
    expect(aggregateDiskPercent(disks)).toBe(73.6);
  });

  it("equal-size disks produce arithmetic average", () => {
    const disks = [disk("/", 100_000, 40), disk("/data", 100_000, 60)];
    expect(aggregateDiskPercent(disks)).toBe(50);
  });

  it("falls back to unweighted average (not disk[0]) when all total_bytes are 0", () => {
    // Degenerate/pseudo-filesystem case — must not collapse to disk[0]'s value.
    const disks = [disk("/", 0, 55), disk("/data", 0, 75)];
    expect(aggregateDiskPercent(disks)).toBe(65); // (55 + 75) / 2, NOT 55
  });

  it("surfaces data from disks beyond index 0 — three-disk mocked system", () => {
    // disk[0] alone (old buggy behavior) would report 20 — the true
    // capacity-weighted aggregate across all three mounts is materially higher.
    const disks = [
      disk("/", 50_000_000_000, 20),
      disk("/data", 500_000_000_000, 90),
      disk("/backup", 450_000_000_000, 95),
    ];
    const result = aggregateDiskPercent(disks);
    expect(result).not.toBe(20); // proves disk[0] is not silently used alone
    // Raw weighted avg: (20*50 + 90*500 + 95*450) / 1000 = 88.75, rounded to 1dp → 88.8
    expect(result).toBe(88.8);
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
  const inserts = 0;
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

  it("persists a multi-disk aggregate (not disk[0]) and preserves all disks in rawJson (nx-k7xa)", async () => {
    const multiDiskMetrics: HealthMetrics = {
      ...baseMetrics,
      disk: [
        { mount: "/", total_bytes: 50_000_000_000, used_bytes: 10_000_000_000, percent: 20 },
        { mount: "/data", total_bytes: 500_000_000_000, used_bytes: 450_000_000_000, percent: 90 },
        { mount: "/backup", total_bytes: 450_000_000_000, used_bytes: 427_500_000_000, percent: 95 },
      ],
    };
    const collector = makeCollectorStub(multiDiskMetrics);
    const { db } = makeDbStub();
    const scheduler = new HealthScheduler(collector, db, 60_000);

    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    expect(insertMock.mock.calls.length).toBe(1);
    const [, persistedSnapshot] = insertMock.mock.calls[0] as unknown as [
      unknown,
      { diskPercent: number | null; rawJson: string },
    ];

    // The old bug persisted disk[0].percent (20) verbatim; the fix aggregates
    // across all three mounts.
    expect(persistedSnapshot.diskPercent).not.toBe(20);
    expect(persistedSnapshot.diskPercent).toBe(88.8);

    // Full per-disk detail — including disks beyond index 0 — must survive in
    // rawJson even though the primary column is a single number.
    const rawDisk = (JSON.parse(persistedSnapshot.rawJson) as HealthMetrics).disk;
    expect(rawDisk).toHaveLength(3);
    expect(rawDisk[1]?.mount).toBe("/data");
    expect(rawDisk[1]?.percent).toBe(90);
    expect(rawDisk[2]?.mount).toBe("/backup");
    expect(rawDisk[2]?.percent).toBe(95);
  });
});
