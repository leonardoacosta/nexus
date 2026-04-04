import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "node:path";
import { runMigrations } from "../db/migrate";
import { insertHealthSnapshot, queryHealthTimeSeries } from "../db/health";
import { startServer } from "../server";
import { HealthCollector } from "../health-collector";
import { HealthScheduler } from "../health-scheduler";
import { downsample } from "./health-history";
import type { HealthSnapshotRow } from "../db/health";

// ── Test helpers ───────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

/** Insert N snapshots spread evenly across the given hours window. */
function seedSnapshots(
  db: Database,
  count: number,
  hoursAgo: number = 24,
): void {
  const now = Date.now();
  const intervalMs = (hoursAgo * 3600_000) / count;

  for (let i = 0; i < count; i++) {
    const ts = new Date(now - (count - i) * intervalMs).toISOString();
    insertHealthSnapshot(db, {
      timestamp: ts,
      cpu_percent: 10 + (i % 90),
      ram_percent: 20 + (i % 80),
      disk_percent: 30 + (i % 70),
      docker_containers: i % 5,
      raw_json: null,
    });
  }
}

// ── 4.1 Scheduler writes snapshots to DB ──────────────────────────────────

describe("HealthScheduler", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("writes a snapshot to the database on each tick", async () => {
    const collector = new HealthCollector();

    // Use a very long interval so the timer doesn't auto-fire;
    // we rely on the immediate tick in start()
    const scheduler = new HealthScheduler(collector, db, 60_000);
    scheduler.start();

    // Give the async tick time to complete
    await new Promise((r) => setTimeout(r, 3_000));
    scheduler.stop();

    const rows = db.query("SELECT * FROM health_snapshots").all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].cpu_percent).not.toBeNull();
    expect(rows[0].ram_percent).not.toBeNull();
    expect(typeof rows[0].timestamp).toBe("string");
  });
});

// ── 4.2 GET /health/history returns time-series data ──────────────────────

describe("GET /health/history", () => {
  let db: Database;
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    db = setupDb();
    server = startServer(0, db);
    baseUrl = `http://localhost:${server.port}`;
  });
  afterEach(() => {
    server.stop();
    db.close();
  });

  it("returns time-series data for ?hours=1", async () => {
    // Seed 10 snapshots in the last hour
    seedSnapshots(db, 10, 1);

    const res = await fetch(`${baseUrl}/health/history?hours=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(10);

    // Each point has the expected shape
    for (const point of body) {
      expect(point).toHaveProperty("timestamp");
      expect(point).toHaveProperty("cpu_percent");
      expect(point).toHaveProperty("ram_percent");
      expect(point).toHaveProperty("disk_percent");
    }

    // Ordered by timestamp ascending
    for (let i = 1; i < body.length; i++) {
      expect(body[i].timestamp >= body[i - 1].timestamp).toBe(true);
    }
  });

  it("defaults to 24 hours when no hours param", async () => {
    seedSnapshots(db, 5, 12);

    const res = await fetch(`${baseUrl}/health/history`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any[];
    expect(body.length).toBe(5);
  });

  it("returns 400 for invalid hours param", async () => {
    const res = await fetch(`${baseUrl}/health/history?hours=abc`);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("hours must be a positive number");
  });

  it("returns 400 for negative hours", async () => {
    const res = await fetch(`${baseUrl}/health/history?hours=-5`);
    expect(res.status).toBe(400);
  });

  // ── 4.4 Empty history returns empty array ───────────────────────────────

  it("returns empty array when no snapshots exist", async () => {
    const res = await fetch(`${baseUrl}/health/history?hours=1`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any[];
    expect(body).toEqual([]);
  });
});

// ── 4.3 Downsampling ─────────────────────────────────────────────────────

describe("downsample", () => {
  it("reduces data points for large datasets", () => {
    // Create 500 rows
    const rows: HealthSnapshotRow[] = [];
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      rows.push({
        timestamp: new Date(now - (500 - i) * 30_000).toISOString(),
        cpu_percent: 50,
        ram_percent: 60,
        disk_percent: 70,
        docker_containers: 2,
        raw_json: null,
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
        timestamp: new Date(Date.now() - (50 - i) * 30_000).toISOString(),
        cpu_percent: i,
        ram_percent: i * 2,
        disk_percent: i * 3,
        docker_containers: 0,
        raw_json: null,
      });
    }

    const result = downsample(rows, 200);
    expect(result.length).toBe(50);
  });

  it("averages values within each bucket", () => {
    // 4 rows, target 2 → 2 buckets of 2
    const rows: HealthSnapshotRow[] = [
      { timestamp: "2026-01-01T00:00:00Z", cpu_percent: 10, ram_percent: 20, disk_percent: 30, docker_containers: 0, raw_json: null },
      { timestamp: "2026-01-01T00:01:00Z", cpu_percent: 20, ram_percent: 40, disk_percent: 50, docker_containers: 0, raw_json: null },
      { timestamp: "2026-01-01T00:02:00Z", cpu_percent: 30, ram_percent: 60, disk_percent: 70, docker_containers: 0, raw_json: null },
      { timestamp: "2026-01-01T00:03:00Z", cpu_percent: 40, ram_percent: 80, disk_percent: 90, docker_containers: 0, raw_json: null },
    ];

    const result = downsample(rows, 2);
    expect(result.length).toBe(2);

    // First bucket: avg(10, 20) = 15, avg(20, 40) = 30, avg(30, 50) = 40
    expect(result[0]!.cpu_percent).toBe(15);
    expect(result[0]!.ram_percent).toBe(30);
    expect(result[0]!.disk_percent).toBe(40);
    expect(result[0]!.timestamp).toBe("2026-01-01T00:00:00Z");

    // Second bucket: avg(30, 40) = 35, avg(60, 80) = 70, avg(70, 90) = 80
    expect(result[1]!.cpu_percent).toBe(35);
    expect(result[1]!.ram_percent).toBe(70);
    expect(result[1]!.disk_percent).toBe(80);
  });

  it("handles null values in averaging", () => {
    const rows: HealthSnapshotRow[] = [
      { timestamp: "2026-01-01T00:00:00Z", cpu_percent: 10, ram_percent: null, disk_percent: 30, docker_containers: 0, raw_json: null },
      { timestamp: "2026-01-01T00:01:00Z", cpu_percent: null, ram_percent: null, disk_percent: 50, docker_containers: 0, raw_json: null },
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

  it("integrates with the API endpoint for large time windows", async () => {
    const db = setupDb();
    // Seed 300 snapshots (more than MAX_POINTS=200)
    seedSnapshots(db, 300, 24);

    const server = startServer(0, db);
    const baseUrl = `http://localhost:${server.port}`;

    const res = await fetch(`${baseUrl}/health/history?hours=24`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any[];
    // Should be downsampled to 200
    expect(body.length).toBe(200);

    server.stop();
    db.close();
  });
});
