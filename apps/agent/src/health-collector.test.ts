import { describe, expect, it, mock, beforeEach, afterAll } from "bun:test";
import type { HealthMetrics } from "@nexus/core";

// ── Mock systeminformation before importing the collector ────────────────────

const siMock = {
  currentLoad: mock(() =>
    Promise.resolve({
      currentLoad: 42.5,
      cpus: [{ load: 40 }, { load: 45 }],
    }),
  ),
  mem: mock(() =>
    Promise.resolve({
      total: 16_000_000_000,
      used: 8_000_000_000,
    }),
  ),
  fsSize: mock(() =>
    Promise.resolve([
      { mount: "/", size: 500_000_000_000, used: 250_000_000_000, use: 50 },
    ]),
  ),
  dockerContainers: mock(() =>
    Promise.resolve([
      { state: "running" },
      { state: "running" },
      { state: "exited" },
    ]),
  ),
  networkStats: mock(() =>
    Promise.resolve([
      { iface: "eth0", rx_bytes: 1000, tx_bytes: 2000 },
    ]),
  ),
  processes: mock(() =>
    Promise.resolve({
      list: [
        { pid: 1, name: "node", cpu: 30, mem: 10, command: "/usr/bin/node server.js", user: "leo", state: "S" },
        { pid: 2, name: "chrome", cpu: 20, mem: 40, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", user: "leo", state: "S" },
        { pid: 3, name: "rust", cpu: 10, mem: 5, command: "/usr/local/bin/cargo build", user: "leo", state: "R" },
      ],
    }),
  ),
};

mock.module("systeminformation", () => ({ default: siMock }));

// Bind the SHARED @nexus/core/node logger spy (nx-509z5) BEFORE the dynamic
// `./server` import below. `./server` transitively loads
// cross-machine-delivery.ts, which binds its `log` at module-load. Without
// this, the REAL pino logger binds and — when this suite wins the load-order
// race — cross-machine-delivery.test.ts's `loggerSpy.warn` reads 0 calls.
const { installCoreNodeMock } = await import("./testing/mock-core-node");
installCoreNodeMock({ mockGetAgentId: false });

// Import after mocking
const { HealthCollector } = await import("./health-collector");

describe("HealthCollector", () => {
  beforeEach(() => {
    // Reset all mocks to defaults before each test
    siMock.currentLoad.mockImplementation(() =>
      Promise.resolve({
        currentLoad: 42.5,
        cpus: [{ load: 40 }, { load: 45 }],
      }),
    );
    siMock.mem.mockImplementation(() =>
      Promise.resolve({
        total: 16_000_000_000,
        used: 8_000_000_000,
      }),
    );
    siMock.fsSize.mockImplementation(() =>
      Promise.resolve([
        { mount: "/", size: 500_000_000_000, used: 250_000_000_000, use: 50 },
      ]),
    );
    siMock.dockerContainers.mockImplementation(() =>
      Promise.resolve([
        { state: "running" },
        { state: "running" },
        { state: "exited" },
      ]),
    );
    siMock.networkStats.mockImplementation(() =>
      Promise.resolve([
        { iface: "eth0", rx_bytes: 1000, tx_bytes: 2000 },
      ]),
    );
    siMock.processes.mockImplementation(() =>
      Promise.resolve({
        list: [
          { pid: 1, name: "node", cpu: 30, mem: 10, command: "/usr/bin/node server.js", user: "leo", state: "S" },
          { pid: 2, name: "chrome", cpu: 20, mem: 40, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", user: "leo", state: "S" },
          { pid: 3, name: "rust", cpu: 10, mem: 5, command: "/usr/local/bin/cargo build", user: "leo", state: "R" },
        ],
      }),
    );
  });

  // ── [4.1] Verify response shape with mocked si ──────────────────────────

  it("collect() returns correct HealthMetrics shape", async () => {
    const collector = new HealthCollector();
    const metrics = await collector.collect();

    // Top-level fields
    expect(typeof metrics.hostname).toBe("string");
    expect(typeof metrics.uptime_seconds).toBe("number");

    // CPU
    expect(metrics.cpu.overall_percent).toBe(42.5);
    expect(metrics.cpu.per_core_percent).toEqual([40, 45]);
    expect(Array.isArray(metrics.cpu.load_average)).toBe(true);
    expect(metrics.cpu.load_average.length).toBe(3);

    // RAM
    expect(metrics.ram.total_bytes).toBe(16_000_000_000);
    expect(metrics.ram.used_bytes).toBe(8_000_000_000);
    expect(metrics.ram.percent).toBe(50);

    // Disk
    expect(metrics.disk).toHaveLength(1);
    expect(metrics.disk[0]!.mount).toBe("/");
    expect(metrics.disk[0]!.total_bytes).toBe(500_000_000_000);
    expect(metrics.disk[0]!.used_bytes).toBe(250_000_000_000);
    expect(metrics.disk[0]!.percent).toBe(50);

    // Docker
    expect(metrics.docker).toEqual({ containers: 3, running: 2 });

    // Network
    expect(metrics.network).toHaveLength(1);
    expect(metrics.network![0]).toEqual({
      iface: "eth0",
      rx_bytes: 1000,
      tx_bytes: 2000,
    });

    // Processes — now carries command/user/state per process-info-extended-fields
    expect(metrics.processes!.top_cpu[0]).toEqual({
      pid: 1,
      name: "node",
      cpu_percent: 30,
      ram_percent: 10,
      command: "/usr/bin/node server.js",
      user: "leo",
      state: "S",
    });
    expect(metrics.processes!.top_ram[0]).toEqual({
      pid: 2,
      name: "chrome",
      cpu_percent: 20,
      ram_percent: 40,
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      user: "leo",
      state: "S",
    });
  });

  // ── process-info-extended-fields scenarios ──────────────────────────────

  it("collect() truncates command at 200 chars with trailing ellipsis", async () => {
    const longCommand = "a".repeat(350);
    siMock.processes.mockImplementation(() =>
      Promise.resolve({
        list: [
          { pid: 99, name: "build", cpu: 50, mem: 10, command: longCommand, user: "leo", state: "R" },
        ],
      }),
    );
    const collector = new HealthCollector();
    const metrics = await collector.collect();
    const proc = metrics.processes!.top_cpu[0]!;
    // 200 retained chars + 1-char ellipsis = 201
    expect(proc.command!.length).toBe(201);
    expect(proc.command!.endsWith("…")).toBe(true);
    expect(proc.command!.slice(0, 200)).toBe("a".repeat(200));
  });

  it("collect() tolerates missing command/user/state on systeminformation row", async () => {
    // Older / stripped systeminformation row with only the legacy four
    // fields. Must NOT throw; the extension fields fall back to null.
    // Cast through `any` so TS doesn't widen the mock signature for the
    // surrounding `siMock.processes` callable.
    const strippedList = [
      { pid: 7, name: "legacy", cpu: 12, mem: 3 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as unknown as any;
    siMock.processes.mockImplementation(() =>
      Promise.resolve({ list: strippedList }),
    );
    const collector = new HealthCollector();
    const metrics = await collector.collect();
    const proc = metrics.processes!.top_cpu[0]!;
    expect(proc.pid).toBe(7);
    expect(proc.name).toBe("legacy");
    expect(proc.command).toBeNull();
    expect(proc.user).toBeNull();
    expect(proc.state).toBeNull();
  });

  // ── [4.2] Docker unavailable → docker: null ─────────────────────────────

  it("returns docker: null when Docker is unavailable", async () => {
    siMock.dockerContainers.mockImplementation(() =>
      Promise.reject(new Error("connect ENOENT /var/run/docker.sock")),
    );

    const collector = new HealthCollector();
    const metrics = await collector.collect();

    expect(metrics.docker).toBeNull();

    // Other fields should still be populated
    expect(metrics.cpu.overall_percent).toBe(42.5);
    expect(metrics.ram.total_bytes).toBe(16_000_000_000);
  });

  it("getLatest() returns null before any collection", () => {
    const collector = new HealthCollector();
    expect(collector.getLatest()).toBeNull();
  });

  // ── [2.1-2.5] Docker detection backoff ──────────────────────────────────────

  it("first Docker failure triggers backoff and subsequent call skips docker subprocess", async () => {
    let callCount = 0;
    siMock.dockerContainers.mockImplementation(() => {
      callCount++;
      return Promise.reject(new Error("docker not found"));
    });

    const collector = new HealthCollector();

    // First collect: Docker fails → backoff set
    const m1 = await collector.collect();
    expect(m1.docker).toBeNull();
    const callsAfterFirst = callCount;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Second collect immediately after: still within backoff window → Docker NOT called again
    const m2 = await collector.collect();
    expect(m2.docker).toBeNull();
    // docker subprocess should NOT have been called again (backoff skips it)
    expect(callCount).toBe(callsAfterFirst);
  });

  it("Docker backoff doubles on each failure up to 10-minute cap", async () => {
    siMock.dockerContainers.mockImplementation(() =>
      Promise.reject(new Error("no docker")),
    );

    const collector = new HealthCollector();

    // Access private backoff state via type cast for inspection
    const c = collector as unknown as {
      dockerBackoffMs: number;
      dockerBackoffUntil: number;
    };

    // Initial backoff: 30_000 ms
    expect(c.dockerBackoffMs).toBe(30_000);

    // Trigger first failure: backoff doubles to 60_000
    await collector.collect();
    expect(c.dockerBackoffMs).toBe(60_000);

    // Reset to allow next collection attempt
    c.dockerBackoffUntil = 0;

    // Second failure: doubles to 120_000
    await collector.collect();
    expect(c.dockerBackoffMs).toBe(120_000);
  });

  it("Docker backoff resets on success", async () => {
    siMock.dockerContainers.mockImplementation(() =>
      Promise.reject(new Error("no docker")),
    );

    const collector = new HealthCollector();
    const c = collector as unknown as {
      dockerBackoffMs: number;
      dockerBackoffUntil: number;
    };

    // Trigger failure to bump backoff
    await collector.collect();
    expect(c.dockerBackoffMs).toBeGreaterThan(30_000);

    // Restore Docker availability
    siMock.dockerContainers.mockImplementation(() =>
      Promise.resolve([{ state: "running" }, { state: "exited" }]),
    );

    // Reset backoff window so Docker is queried again
    c.dockerBackoffUntil = 0;

    const m = await collector.collect();
    expect(m.docker).not.toBeNull();
    // Backoff should be reset to initial
    expect(c.dockerBackoffMs).toBe(30_000);
    expect(c.dockerBackoffUntil).toBe(0);
  });

  it("Docker backoff is capped at 10 minutes (600_000 ms)", async () => {
    siMock.dockerContainers.mockImplementation(() =>
      Promise.reject(new Error("no docker")),
    );

    const collector = new HealthCollector();
    const c = collector as unknown as {
      dockerBackoffMs: number;
      dockerBackoffUntil: number;
    };

    // Force backoff well past the cap
    c.dockerBackoffMs = 400_000;
    c.dockerBackoffUntil = 0;

    await collector.collect();

    // Should double 400_000 → 800_000 but cap at 600_000
    expect(c.dockerBackoffMs).toBe(600_000);
  });

  // ── [6.1/6.2] collectedAt field ──────────────────────────────────────────

  it("collect() populates collectedAt as an ISO-8601 string", async () => {
    const before = new Date().toISOString();
    const collector = new HealthCollector();
    const metrics = await collector.collect();

    expect(typeof metrics.collectedAt).toBe("string");
    // Should be a valid date
    const parsed = new Date(metrics.collectedAt!);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // Should be after test start and within 5s
    expect(parsed.toISOString() >= before).toBe(true);
    expect(Date.now() - parsed.getTime()).toBeLessThan(5_000);
  });
});

// ── [4.3] /health endpoint shape ──────────────────────────────────────────

// Dynamic import so the server's HealthCollector also gets mocked systeminformation
const { startServer, healthCollector } = await import("./server");

/** Poll until the health collector has data (mocked — should be near-instant). */
async function waitForCollector(maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (!healthCollector.getLatest() && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("/health endpoint", () => {
  const server = startServer(0);
  const baseUrl = `http://localhost:${server.port}`;

  afterAll(() => {
    healthCollector.stop();
    server.stop();
  });

  it("returns HealthMetrics shape (default — no detail)", async () => {
    await waitForCollector();

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = await res.json() as HealthMetrics;

    // Required fields
    expect(typeof body.hostname).toBe("string");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.cpu).toBeDefined();
    expect(typeof body.cpu.overall_percent).toBe("number");
    expect(Array.isArray(body.cpu.per_core_percent)).toBe(true);
    expect(body.ram).toBeDefined();
    expect(typeof body.ram.percent).toBe("number");
    expect(Array.isArray(body.disk)).toBe(true);

    // Detail fields should NOT be present without ?detail=true
    expect(body.network).toBeUndefined();
    expect(body.processes).toBeUndefined();
  });

  it("returns detail fields with ?detail=true", async () => {
    await waitForCollector();

    const res = await fetch(`${baseUrl}/health?detail=true`);
    expect(res.status).toBe(200);

    const body = await res.json() as HealthMetrics;

    expect(Array.isArray(body.network)).toBe(true);
    expect(body.processes).toBeDefined();
    expect(Array.isArray(body.processes!.top_cpu)).toBe(true);
    expect(Array.isArray(body.processes!.top_ram)).toBe(true);
  });
});
