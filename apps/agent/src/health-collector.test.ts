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
        { pid: 1, name: "node", cpu: 30, mem: 10 },
        { pid: 2, name: "chrome", cpu: 20, mem: 40 },
        { pid: 3, name: "rust", cpu: 10, mem: 5 },
      ],
    }),
  ),
};

mock.module("systeminformation", () => ({ default: siMock }));

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
          { pid: 1, name: "node", cpu: 30, mem: 10 },
          { pid: 2, name: "chrome", cpu: 20, mem: 40 },
          { pid: 3, name: "rust", cpu: 10, mem: 5 },
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

    // Processes
    expect(metrics.processes!.top_cpu[0]).toEqual({
      pid: 1,
      name: "node",
      cpu_percent: 30,
      ram_percent: 10,
    });
    expect(metrics.processes!.top_ram[0]).toEqual({
      pid: 2,
      name: "chrome",
      cpu_percent: 20,
      ram_percent: 40,
    });
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
