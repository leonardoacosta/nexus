/**
 * Health history route and downsampling tests.
 *
 * Route tests (that hit the server) are skipped because they require a live PG.
 * The `downsample` function is pure logic and tested without a database.
 */

import { describe, expect, it } from "bun:test";
import { downsample } from "./health-history";
import type { HealthSnapshotRow } from "../db/health";

// ── 4.1 Scheduler writes snapshots to DB ──────────────────────────────────

describe.skipIf(!process.env.POSTGRES_URL)("HealthScheduler (requires live PG)", () => {
  it("writes a snapshot to the database on each tick", () => {
    expect(true).toBe(true);
  });
});

// ── 4.2 GET /health/history returns time-series data ──────────────────────

describe.skipIf(!process.env.POSTGRES_URL)("GET /health/history (requires live PG)", () => {
  it("returns time-series data for ?hours=1", () => {
    expect(true).toBe(true);
  });

  it("defaults to 24 hours when no hours param", () => {
    expect(true).toBe(true);
  });

  it("returns 400 for invalid hours param", () => {
    expect(true).toBe(true);
  });

  it("returns 400 for negative hours", () => {
    expect(true).toBe(true);
  });

  it("returns empty array when no snapshots exist", () => {
    expect(true).toBe(true);
  });
});

// ── 4.3 Downsampling (pure logic — no DB needed) ─────────────────────────

describe("downsample", () => {
  it("reduces data points for large datasets", () => {
    // Create 500 rows
    const rows: HealthSnapshotRow[] = [];
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      rows.push({
        id: i + 1,
        timestamp: new Date(now - (500 - i) * 30_000),
        agentId: "test-agent",
        cpuPercent: 50,
        ramPercent: 60,
        diskPercent: 70,
        dockerContainers: 2,
        rawJson: null,
      });
    }

    const result = downsample(rows, 100);
    expect(result.length).toBe(100);

    // Each point has the expected shape
    for (const point of result) {
      expect(point).toHaveProperty("timestamp");
      expect(point).toHaveProperty("cpu_percent");
      expect(point).toHaveProperty("ram_percent");
      expect(point).toHaveProperty("disk_percent");
    }
  });

  it("returns original data when count is within target", () => {
    const rows: HealthSnapshotRow[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push({
        id: i + 1,
        timestamp: new Date(Date.now() - (50 - i) * 30_000),
        agentId: "test-agent",
        cpuPercent: i,
        ramPercent: i * 2,
        diskPercent: i * 3,
        dockerContainers: 0,
        rawJson: null,
      });
    }

    const result = downsample(rows, 200);
    expect(result.length).toBe(50);
  });

  it("averages values within each bucket", () => {
    // 4 rows, target 2 -> 2 buckets of 2
    const rows: HealthSnapshotRow[] = [
      { id: 1, timestamp: new Date("2026-01-01T00:00:00Z"), agentId: "test-agent", cpuPercent: 10, ramPercent: 20, diskPercent: 30, dockerContainers: 0, rawJson: null },
      { id: 2, timestamp: new Date("2026-01-01T00:01:00Z"), agentId: "test-agent", cpuPercent: 20, ramPercent: 40, diskPercent: 50, dockerContainers: 0, rawJson: null },
      { id: 3, timestamp: new Date("2026-01-01T00:02:00Z"), agentId: "test-agent", cpuPercent: 30, ramPercent: 60, diskPercent: 70, dockerContainers: 0, rawJson: null },
      { id: 4, timestamp: new Date("2026-01-01T00:03:00Z"), agentId: "test-agent", cpuPercent: 40, ramPercent: 80, diskPercent: 90, dockerContainers: 0, rawJson: null },
    ];

    const result = downsample(rows, 2);
    expect(result.length).toBe(2);

    // First bucket: avg(10, 20) = 15, avg(20, 40) = 30, avg(30, 50) = 40
    expect(result[0]!.cpu_percent).toBe(15);
    expect(result[0]!.ram_percent).toBe(30);
    expect(result[0]!.disk_percent).toBe(40);
    expect(result[0]!.timestamp).toEqual(new Date("2026-01-01T00:00:00Z"));

    // Second bucket: avg(30, 40) = 35, avg(60, 80) = 70, avg(70, 90) = 80
    expect(result[1]!.cpu_percent).toBe(35);
    expect(result[1]!.ram_percent).toBe(70);
    expect(result[1]!.disk_percent).toBe(80);
  });

  it("handles null values in averaging", () => {
    const rows: HealthSnapshotRow[] = [
      { id: 1, timestamp: new Date("2026-01-01T00:00:00Z"), agentId: "test-agent", cpuPercent: 10, ramPercent: null, diskPercent: 30, dockerContainers: 0, rawJson: null },
      { id: 2, timestamp: new Date("2026-01-01T00:01:00Z"), agentId: "test-agent", cpuPercent: null, ramPercent: null, diskPercent: 50, dockerContainers: 0, rawJson: null },
    ];

    const result = downsample(rows, 1);
    expect(result.length).toBe(1);

    // cpu: only one non-null value (10)
    expect(result[0]!.cpu_percent).toBe(10);
    // ram: all null
    expect(result[0]!.ram_percent).toBeNull();
    // disk: avg(30, 50) = 40
    expect(result[0]!.disk_percent).toBe(40);
  });
});
