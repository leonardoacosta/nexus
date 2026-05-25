// health-regression.test.ts — Wave-3 regression locks for the
// health-monitoring-observability change (task 3.1).
//
// Three contracts are pinned here, one per Wave-3 fix:
//
//   1. multi-disk capture (task 2.2) — `aggregateDiskPercent` (exported from
//      health-scheduler.ts) must aggregate ALL mounts. A 2+ disk input must
//      NOT collapse to `disk[0]`, and the scheduler's persisted snapshot must
//      retain every disk in `rawJson`.
//
//   2. collector logging on error (task 2.1) — `HealthCollector` (via
//      `createLogger("agent:health-collector")`) must surface a per-source
//      failure as a `warn` and degrade to a safe fallback rather than
//      rejecting the whole tick.
//
//   3. timestamp index (task 1.1) — the `health_snapshots_timestamp_idx`
//      declared in migration 0002 + the drizzle schema is present. The
//      query-speed benefit isn't unit-testable, but its declaration is.
//
// Patterns reused from health-scheduler.test.ts (stub collector + db, module
// mock of ./db/health) and health-collector.test.ts (mock.module of
// systeminformation before import).

import {
  describe,
  expect,
  it,
  mock,
  beforeEach,
} from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { HealthMetrics } from "@nexus/core";
import type { Db } from "@nexus/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 1) Multi-disk capture: aggregateDiskPercent never collapses to disk[0] ───

// `aggregateDiskPercent` is a pure exported helper, so it can be imported and
// asserted directly without any systeminformation mocking.
import { aggregateDiskPercent } from "./health-scheduler";

/** Build a disk entry with the four fields HealthMetrics["disk"] carries. */
function disk(mount: string, total_bytes: number, percent: number) {
  return { mount, total_bytes, used_bytes: Math.round(total_bytes * (percent / 100)), percent };
}

describe("multi-disk capture: aggregateDiskPercent (task 2.2 regression)", () => {
  it("does NOT collapse a 2-disk input to disk[0]'s value", () => {
    // Two disks at different percents. The pre-fix bug took only disk[0]
    // (10%), discarding the larger 80%-full mount entirely.
    const disks = [
      disk("/", 10_000_000_000, 10),
      disk("/data", 100_000_000_000, 80),
    ];
    const aggregate = aggregateDiskPercent(disks);

    // The aggregate must differ from disk[0].percent (10) — proving disks
    // 1..n are not dropped.
    expect(aggregate).not.toBe(disks[0]!.percent);
    // Capacity-weighted: (10*10 + 80*100) / 110 = 8100/110 ≈ 73.6 — dominated
    // by the larger /data mount, the OPPOSITE of the disk[0] collapse.
    expect(aggregate).toBe(73.6);
  });

  it("weights by capacity so the larger mount dominates the headline figure", () => {
    const disks = [
      disk("/", 500_000_000_000, 90), // big, nearly full
      disk("/boot", 1_000_000_000, 5), // tiny, nearly empty
    ];
    const aggregate = aggregateDiskPercent(disks)!;
    // The big mount (90%) must pull the aggregate near 90, not toward 5.
    expect(aggregate).toBeGreaterThan(85);
    expect(aggregate).toBeLessThanOrEqual(90);
  });

  it("falls back to an UNWEIGHTED average across ALL disks when every total_bytes is 0", () => {
    // Degraded / pseudo filesystems can report total_bytes 0. The fix must
    // still average across both disks rather than collapsing to disk[0] (40).
    const disks = [disk("/", 0, 40), disk("/overlay", 0, 60)];
    const aggregate = aggregateDiskPercent(disks);
    expect(aggregate).not.toBe(disks[0]!.percent); // not 40 (the disk[0] collapse)
    expect(aggregate).toBe(50); // (40 + 60) / 2
  });

  it("returns null for an empty disk array", () => {
    expect(aggregateDiskPercent([])).toBeNull();
  });

  it("returns the sole disk's percent for a single-disk machine (no regression for the common case)", () => {
    expect(aggregateDiskPercent([disk("/", 500_000_000_000, 55)])).toBe(55);
  });
});

// ── 1b) Multi-disk capture: scheduler retains ALL disks in rawJson ───────────

// Mock the db insert sink so we can capture the snapshot the scheduler builds.
const insertMock = mock(
  (_db: unknown, _snapshot: { rawJson: string }) => Promise.resolve(),
);
mock.module("./db/health", () => ({
  insertHealthSnapshot: insertMock,
}));

import { HealthScheduler } from "./health-scheduler";
import type { HealthCollector } from "./health-collector";

/** Minimal stub collector returning a fixed metrics payload. */
function makeCollectorStub(latest: HealthMetrics | null): HealthCollector {
  return {
    getLatest: mock(() => latest),
    collect: mock(() => Promise.resolve(latest as HealthMetrics)),
    start: mock(() => {}),
    stop: mock(() => {}),
  } as unknown as HealthCollector;
}

const multiDiskMetrics: HealthMetrics = {
  hostname: "test-host",
  uptime_seconds: 100,
  collectedAt: new Date().toISOString(),
  cpu: { overall_percent: 10, per_core_percent: [10], load_average: [0, 0, 0] },
  ram: { total_bytes: 1000, used_bytes: 500, percent: 50 },
  disk: [
    disk("/", 10_000_000_000, 10),
    disk("/data", 100_000_000_000, 80),
    disk("/boot", 1_000_000_000, 5),
  ],
  docker: null,
  db_ok: true,
  last_watcher_tick_ms: 0,
  socket_server_listening: true,
};

describe("multi-disk capture: scheduler snapshot retains all disks (task 2.2 regression)", () => {
  beforeEach(() => {
    insertMock.mockReset();
    insertMock.mockImplementation(() => Promise.resolve());
  });

  it("persists EVERY disk in rawJson and an aggregated (not disk[0]) diskPercent", async () => {
    const collector = makeCollectorStub(multiDiskMetrics);
    const db = {} as unknown as Db;
    const scheduler = new HealthScheduler(collector, db, 60_000);

    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    expect(insertMock.mock.calls.length).toBe(1);
    const snapshot = insertMock.mock.calls[0]![1] as {
      rawJson: string;
      diskPercent: number | null;
    };

    // rawJson retains the full per-disk array — all three mounts survive.
    const raw = JSON.parse(snapshot.rawJson) as HealthMetrics;
    expect(raw.disk).toHaveLength(3);
    expect(raw.disk.map((d) => d.mount).sort()).toEqual(["/", "/boot", "/data"]);

    // The summary column is the cross-mount aggregate, NOT disk[0].percent (10).
    expect(snapshot.diskPercent).not.toBe(multiDiskMetrics.disk[0]!.percent);
    expect(snapshot.diskPercent).toBe(aggregateDiskPercent(multiDiskMetrics.disk));
  });
});

// ── 2) Collector logging on error: failing source logs + degrades ────────────

// We need a per-test view of the logger created via createLogger. Mock the
// node logger barrel so HealthCollector's `createLogger("agent:health-collector")`
// returns a spy whose warn/error calls we can assert. systeminformation is
// mocked so we can force a single source to throw.

type LogCall = { args: unknown[] };

const warnSpy: LogCall[] = [];
const errorSpy: LogCall[] = [];

const spyLogger = {
  info: () => {},
  debug: () => {},
  warn: (...args: unknown[]) => {
    warnSpy.push({ args });
  },
  error: (...args: unknown[]) => {
    errorSpy.push({ args });
  },
  fatal: () => {},
  child: () => spyLogger,
};

mock.module("@nexus/core/node", () => ({
  createLogger: () => spyLogger,
  logger: spyLogger,
  getAgentId: () => "test-agent",
}));

// systeminformation mock — defaults are healthy; individual tests override a
// single source to reject so the collectStep degradation path is exercised.
const siMock = {
  currentLoad: mock(() =>
    Promise.resolve({ currentLoad: 42.5, cpus: [{ load: 40 }, { load: 45 }] }),
  ),
  mem: mock(() => Promise.resolve({ total: 16_000_000_000, used: 8_000_000_000 })),
  fsSize: mock(() =>
    Promise.resolve([{ mount: "/", size: 500_000_000_000, used: 250_000_000_000, use: 50 }]),
  ),
  dockerContainers: mock(() => Promise.resolve([{ state: "running" }])),
  networkStats: mock(() => Promise.resolve([{ iface: "eth0", rx_bytes: 1, tx_bytes: 2 }])),
  processes: mock(() => Promise.resolve({ list: [] })),
};
mock.module("systeminformation", () => ({ default: siMock }));

const { HealthCollector } = await import("./health-collector");

function resetSi(): void {
  siMock.currentLoad.mockImplementation(() =>
    Promise.resolve({ currentLoad: 42.5, cpus: [{ load: 40 }, { load: 45 }] }),
  );
  siMock.mem.mockImplementation(() =>
    Promise.resolve({ total: 16_000_000_000, used: 8_000_000_000 }),
  );
  siMock.fsSize.mockImplementation(() =>
    Promise.resolve([{ mount: "/", size: 500_000_000_000, used: 250_000_000_000, use: 50 }]),
  );
  siMock.dockerContainers.mockImplementation(() =>
    Promise.resolve([{ state: "running" }]),
  );
  siMock.networkStats.mockImplementation(() =>
    Promise.resolve([{ iface: "eth0", rx_bytes: 1, tx_bytes: 2 }]),
  );
  siMock.processes.mockImplementation(() => Promise.resolve({ list: [] }));
}

describe("collector logging on error (task 2.1 regression)", () => {
  beforeEach(() => {
    warnSpy.length = 0;
    errorSpy.length = 0;
    resetSi();
  });

  it("a failing disk source logs a warn naming the step AND collect() still resolves", async () => {
    siMock.fsSize.mockImplementation(() =>
      Promise.reject(new Error("EACCES: fsSize permission denied")),
    );

    const collector = new HealthCollector();
    // collect() must NOT throw — the failure is isolated to the one source.
    const metrics = await collector.collect();

    // A warn was logged surfacing the failing step (not swallowed silently).
    expect(warnSpy.length).toBeGreaterThanOrEqual(1);
    // The structured first arg carries the step name + error so WHICH source
    // failed is observable.
    const stepWarn = warnSpy.find((c) => {
      const meta = c.args[0] as { step?: string } | undefined;
      return meta?.step === "disk";
    });
    expect(stepWarn).toBeDefined();
    expect((stepWarn!.args[0] as { err?: unknown }).err).toBeInstanceOf(Error);

    // Degraded to the safe fallback: empty disk array (not a thrown tick).
    expect(metrics.disk).toEqual([]);
    // Healthy sources are still populated — the failure didn't poison the tick.
    expect(metrics.cpu.overall_percent).toBe(42.5);
    expect(metrics.ram.total_bytes).toBe(16_000_000_000);
  });

  it("an empty-disk result (degraded source) is surfaced as a warn, not silently dropped", async () => {
    siMock.fsSize.mockImplementation(() => Promise.resolve([]));

    const collector = new HealthCollector();
    const metrics = await collector.collect();

    expect(metrics.disk).toEqual([]);
    // The collector explicitly warns when disk collection returns no mounts.
    const emptyWarn = warnSpy.find((c) =>
      typeof c.args[0] === "string"
        ? (c.args[0] as string).includes("no mounts")
        : typeof c.args[1] === "string" && (c.args[1] as string).includes("no mounts"),
    );
    expect(emptyWarn).toBeDefined();
  });

  it("a failing cpu source degrades to the 0-load fallback and logs (no thrown tick)", async () => {
    siMock.currentLoad.mockImplementation(() =>
      Promise.reject(new Error("currentLoad unavailable")),
    );

    const collector = new HealthCollector();
    const metrics = await collector.collect();

    // Degraded fallback: overall 0, no per-core data.
    expect(metrics.cpu.overall_percent).toBe(0);
    expect(metrics.cpu.per_core_percent).toEqual([]);
    // Warn surfaced for the cpu step.
    const cpuWarn = warnSpy.find((c) => {
      const meta = c.args[0] as { step?: string } | undefined;
      return meta?.step === "cpu";
    });
    expect(cpuWarn).toBeDefined();
  });
});

// ── 3) Timestamp index present (task 1.1 regression) ─────────────────────────

describe("health_snapshots_timestamp_idx present (task 1.1 regression)", () => {
  it("migration 0002 declares the timestamp index on health_snapshots", () => {
    // Migration files live at packages/db/drizzle relative to repo root.
    const migrationPath = resolve(
      __dirname,
      "../../../packages/db/drizzle/0002_bitter_nova.sql",
    );
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('CREATE INDEX "health_snapshots_timestamp_idx"');
    expect(sql).toContain('ON "health_snapshots"');
    expect(sql.toLowerCase()).toContain("timestamp");
  });

  it("the drizzle schema declares the timestamp index", () => {
    const schemaPath = resolve(
      __dirname,
      "../../../packages/db/src/schema/healthSnapshots.ts",
    );
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toContain("health_snapshots_timestamp_idx");
    // The index is declared on the timestamp column.
    expect(schema).toMatch(/index\(["']health_snapshots_timestamp_idx["']\)\s*\.on\(\s*table\.timestamp\s*\)/);
  });
});
