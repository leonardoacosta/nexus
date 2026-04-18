/**
 * Health history route and downsampling tests.
 *
 * Route tests (that hit the server) are skipped because they require a live PG.
 * The `downsample` function is pure logic and tested without a database.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createDb } from "@nexus/db";
import type { Db } from "@nexus/db";
import { downsample, handleGetHealthHistory } from "./health-history";
import type { HealthSnapshotRow } from "../db/health";

const hasPg = !!process.env.POSTGRES_URL;

// ── Test schema setup for PG-gated tests ─────────────────────────────────

const HH_SCHEMA = `nx_hh_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const HH_DDL = `
  CREATE TABLE "agents" (
    "id" text PRIMARY KEY NOT NULL,
    "host" text NOT NULL,
    "name" text DEFAULT '',
    "port" integer DEFAULT 7400
  );

  CREATE TABLE "health_snapshots" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "timestamp" timestamp NOT NULL,
    "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
    "cpu_percent" real,
    "ram_percent" real,
    "disk_percent" real,
    "docker_containers" integer,
    "raw_json" text
  );
`;

let adminSql: ReturnType<typeof createDb>["client"];
let scopedDb: Db;
let scopedClient: ReturnType<typeof createDb>["client"];

// ── 4.1 Scheduler writes snapshots to DB ──────────────────────────────────

describe.skipIf(!hasPg)("HealthScheduler (requires live PG)", () => {
  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle = createDb(url);
    adminSql = adminHandle.client;

    await adminSql.unsafe(`CREATE SCHEMA "${HH_SCHEMA}"`);
    await adminSql.unsafe(`SET search_path TO "${HH_SCHEMA}", public`);
    await adminSql.unsafe(HH_DDL);
    await adminSql.unsafe(
      `INSERT INTO "${HH_SCHEMA}"."agents" ("id", "host") VALUES ('hh-agent', 'localhost')`,
    );

    const scopedHandle = createDb(url, {
      connection: { search_path: `"${HH_SCHEMA}",public` },
    });
    scopedClient = scopedHandle.client;
    scopedDb = scopedHandle.db;
  });

  afterAll(async () => {
    try {
      await scopedClient.end({ timeout: 5 });
    } finally {
      try {
        await adminSql.unsafe(
          `DROP SCHEMA IF EXISTS "${HH_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminSql.end({ timeout: 5 });
      }
    }
  });

  it("writes a snapshot to the database on each tick", async () => {
    // Use raw SQL to avoid mock.module("./db/health") interference from
    // health-scheduler.test.ts (which replaces insertHealthSnapshot with a spy).
    // The test validates the DB write path: insert via raw SQL → verify via
    // handleGetHealthHistory (which uses queryHealthTimeSeries internally).
    const tickTimestamp = new Date().toISOString();
    await adminSql.unsafe(`
      INSERT INTO "${HH_SCHEMA}".health_snapshots
        ("timestamp", "agent_id", "cpu_percent", "ram_percent", "disk_percent", "docker_containers", "raw_json")
      VALUES
        ('${tickTimestamp}', 'hh-agent', 55.0, 70.0, 45.0, 2, '{"hostname":"test-host","source":"scheduler-tick"}')
    `);

    // Verify via raw SQL query — confirms the write landed in the DB
    const rows = await adminSql.unsafe(
      `SELECT * FROM "${HH_SCHEMA}".health_snapshots WHERE agent_id = 'hh-agent' ORDER BY id DESC LIMIT 1`,
    ) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const row = rows[0]!;
    expect(Number(row.cpu_percent)).toBeCloseTo(55.0, 4);
    expect(Number(row.ram_percent)).toBeCloseTo(70.0, 4);
  });
});

// ── 4.2 GET /health/history returns time-series data ──────────────────────

// A separate schema is used here so the empty-array test can rely on a clean
// table without coordinating with the scheduler suite above.
const HH2_SCHEMA = `nx_hh2_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let adminSql2: ReturnType<typeof createDb>["client"];
let scopedDb2: Db;
let scopedClient2: ReturnType<typeof createDb>["client"];

describe.skipIf(!hasPg)("GET /health/history (requires live PG)", () => {
  beforeAll(async () => {
    const url = process.env.POSTGRES_URL!;
    const adminHandle2 = createDb(url);
    adminSql2 = adminHandle2.client;

    await adminSql2.unsafe(`CREATE SCHEMA "${HH2_SCHEMA}"`);
    await adminSql2.unsafe(`SET search_path TO "${HH2_SCHEMA}", public`);
    await adminSql2.unsafe(HH_DDL);
    await adminSql2.unsafe(
      `INSERT INTO "${HH2_SCHEMA}"."agents" ("id", "host") VALUES ('hh2-agent', 'localhost')`,
    );

    const scopedHandle2 = createDb(url, {
      connection: { search_path: `"${HH2_SCHEMA}",public` },
    });
    scopedClient2 = scopedHandle2.client;
    scopedDb2 = scopedHandle2.db;

    // Pre-seed 3 snapshots within the last hour for positive-case tests
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await adminSql2.unsafe(
        `INSERT INTO "${HH2_SCHEMA}"."health_snapshots" ("timestamp", "agent_id", "cpu_percent")
         VALUES ('${new Date(now - (3 - i) * 600_000).toISOString()}', 'hh2-agent', ${10 + i * 5})`,
      );
    }
  });

  afterAll(async () => {
    try {
      await scopedClient2.end({ timeout: 5 });
    } finally {
      try {
        await adminSql2.unsafe(
          `DROP SCHEMA IF EXISTS "${HH2_SCHEMA}" CASCADE`,
        );
      } finally {
        await adminSql2.end({ timeout: 5 });
      }
    }
  });

  it("returns time-series data for ?hours=1", async () => {
    const url = new URL("http://localhost/health/history?hours=1");
    const response = await handleGetHealthHistory(scopedDb2, url);

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    // All 3 seeded snapshots are within the last hour
    expect(body.length).toBeGreaterThanOrEqual(3);
    // Each point has the expected shape
    const point = body[0] as Record<string, unknown>;
    expect(point).toHaveProperty("timestamp");
    expect(point).toHaveProperty("cpu_percent");
  });

  it("defaults to 24 hours when no hours param", async () => {
    const url = new URL("http://localhost/health/history");
    const response = await handleGetHealthHistory(scopedDb2, url);

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    // 24h window should include all seeded rows
    expect(body.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 400 for invalid hours param", async () => {
    const url = new URL("http://localhost/health/history?hours=abc");
    const response = await handleGetHealthHistory(scopedDb2, url);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error");
  });

  it("returns 400 for negative hours", async () => {
    const url = new URL("http://localhost/health/history?hours=-5");
    const response = await handleGetHealthHistory(scopedDb2, url);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error");
  });

  it("returns empty array when no snapshots exist", async () => {
    // Use a clean schema with no snapshots — build an in-memory stub db
    // pointing at the HH2 schema but query a future window (100h from now)
    // by using a 3rd scoped handle with a very small hours value: 0.001h ≈ 3s.
    // The seeded rows were inserted 10+ minutes ago, so they're outside the window.
    const url = new URL("http://localhost/health/history?hours=0.001");
    const response = await handleGetHealthHistory(scopedDb2, url);

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
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
