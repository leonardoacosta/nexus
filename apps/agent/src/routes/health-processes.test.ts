/**
 * Unit tests for `GET /health/processes`.
 *
 * Spec: openspec/changes/health-tab-process-view (requirement
 * `health-processes-endpoint`).
 *
 * Tests exercise `handleHealthProcesses(url, state)` directly with a stub
 * ServerState — no Bun.serve / network needed. The handler is a pure
 * function over the collector cache, so unit-level coverage is enough.
 */

import { describe, expect, it } from "bun:test";
import type { HealthMetrics, HealthProcessesResponse, ProcessInfo } from "@nexus/core";
import { handleHealthProcesses } from "./health-processes";

// ── Stub ServerState ─────────────────────────────────────────────────────

interface StubState {
  healthCollector: {
    getLatest(): HealthMetrics | null;
  };
}

function buildProcesses(count: number, field: "cpu_percent" | "ram_percent"): ProcessInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    pid: 1000 + i,
    name: `proc${i}`,
    cpu_percent: field === "cpu_percent" ? 100 - i : 5,
    ram_percent: field === "ram_percent" ? 100 - i : 5,
    command: `/usr/bin/proc${i}`,
    user: "leo",
    state: "S",
  }));
}

function stubLatestWith(top_cpu: ProcessInfo[], top_ram: ProcessInfo[]): StubState {
  const metrics: HealthMetrics = {
    hostname: "test-host",
    uptime_seconds: 100,
    collectedAt: "2026-05-21T12:00:00.000Z",
    cpu: { overall_percent: 5, per_core_percent: [], load_average: [] },
    ram: { total_bytes: 0, used_bytes: 0, percent: 0 },
    disk: [],
    docker: null,
    processes: { top_cpu, top_ram },
    db_ok: true,
    last_watcher_tick_ms: 0,
    socket_server_listening: true,
  };
  return { healthCollector: { getLatest: () => metrics } };
}

function stubWarmingUp(): StubState {
  return { healthCollector: { getLatest: () => null } };
}

// Cast through unknown — ServerState is a class with private constructor; the
// handler only reads `state.healthCollector.getLatest()` so a structural stub
// suffices for unit testing.
function asState(stub: StubState): import("../server-websocket").ServerState {
  return stub as unknown as import("../server-websocket").ServerState;
}

// ── Scenarios from health-timeseries/spec.md ─────────────────────────────

describe("GET /health/processes", () => {
  it("default limit returns top 10 of each list (collector cached 30)", async () => {
    const cpu = buildProcesses(30, "cpu_percent");
    const ram = buildProcesses(30, "ram_percent");
    const state = stubLatestWith(cpu, ram);

    const url = new URL("http://localhost/health/processes");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthProcessesResponse;
    expect(body.top_cpu).toHaveLength(10);
    expect(body.top_ram).toHaveLength(10);
    expect(body.collectedAt).toBe("2026-05-21T12:00:00.000Z");
    // Descending order preserved by collector — first entry has the largest cpu
    expect(body.top_cpu[0]!.cpu_percent).toBeGreaterThanOrEqual(body.top_cpu[9]!.cpu_percent);
  });

  it("explicit limit=25 returns top 25 of each list", async () => {
    const cpu = buildProcesses(30, "cpu_percent");
    const ram = buildProcesses(30, "ram_percent");
    const state = stubLatestWith(cpu, ram);

    const url = new URL("http://localhost/health/processes?limit=25");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthProcessesResponse;
    expect(body.top_cpu).toHaveLength(25);
    expect(body.top_ram).toHaveLength(25);
  });

  it("limit=0 returns 400 with documented error message", async () => {
    const state = stubLatestWith(buildProcesses(5, "cpu_percent"), buildProcesses(5, "ram_percent"));
    const url = new URL("http://localhost/health/processes?limit=0");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("limit must be 1..50");
  });

  it("limit=51 returns 400 with documented error message", async () => {
    const state = stubLatestWith(buildProcesses(5, "cpu_percent"), buildProcesses(5, "ram_percent"));
    const url = new URL("http://localhost/health/processes?limit=51");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("limit must be 1..50");
  });

  it("limit=abc (non-numeric) returns 400", async () => {
    const state = stubLatestWith(buildProcesses(5, "cpu_percent"), buildProcesses(5, "ram_percent"));
    const url = new URL("http://localhost/health/processes?limit=abc");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(400);
  });

  it("collector warming up returns 200 with empty arrays and collectedAt: null", async () => {
    const state = stubWarmingUp();
    const url = new URL("http://localhost/health/processes");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthProcessesResponse;
    expect(body.top_cpu).toEqual([]);
    expect(body.top_ram).toEqual([]);
    expect(body.collectedAt).toBeNull();
  });

  it("latest exists but processes block undefined returns empty payload (no 500)", async () => {
    // Defensive: an older / stripped HealthMetrics could lack `processes`.
    const metricsNoProcs: HealthMetrics = {
      hostname: "test-host",
      uptime_seconds: 100,
      collectedAt: "2026-05-21T12:00:00.000Z",
      cpu: { overall_percent: 5, per_core_percent: [], load_average: [] },
      ram: { total_bytes: 0, used_bytes: 0, percent: 0 },
      disk: [],
      docker: null,
      db_ok: true,
      last_watcher_tick_ms: 0,
      socket_server_listening: true,
    };
    const state: StubState = {
      healthCollector: { getLatest: () => metricsNoProcs },
    };
    const url = new URL("http://localhost/health/processes");
    const res = handleHealthProcesses(url, asState(state));

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthProcessesResponse;
    expect(body.top_cpu).toEqual([]);
    expect(body.top_ram).toEqual([]);
    expect(body.collectedAt).toBeNull();
  });
});
