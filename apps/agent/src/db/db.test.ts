import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runMigrations } from "./migrate";
import {
  insertSession,
  updateSessionStatus,
  queryActiveSessions,
  queryRecentSessions,
  getSessionById,
} from "./sessions";
import type { SessionRow } from "./sessions";
import { insertHealthSnapshot, queryHealthTimeSeries } from "./health";
import { appendSessionEvent, querySessionEvents } from "./events";
import { runRetentionCleanup } from "./retention";

/** Create an in-memory DB with WAL pragmas and run migrations. */
function setupDb(): Database {
  const db = new Database(":memory:");
  // WAL mode isn't meaningful for :memory: but we still call it for parity
  db.exec("PRAGMA journal_mode = WAL");

  // Point migration runner at the real migrations directory
  const migrationsDir = join(import.meta.dir, "../../migrations");
  runMigrations(db, migrationsDir);

  return db;
}

/** Helper to build a session row with sensible defaults. */
function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-001",
    project: "nexus",
    machine: "dev-1",
    status: "active",
    started_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    ended_at: null,
    pid: 1234,
    cwd: "/home/user/dev/nx",
    ...overrides,
  };
}

// ─── 7.1 Migration runner ────────────────────────────────────────────────────

describe("migration runner", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("creates the sessions table", () => {
    const rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("creates the health_snapshots table", () => {
    const rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='health_snapshots'",
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("creates the session_events table", () => {
    const rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_events'",
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("tracks applied migrations in _migrations table", () => {
    const rows = db.query("SELECT name FROM _migrations").all() as {
      name: string;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.name).toBe("001_init.sql");
  });

  it("is idempotent — running twice does not error", () => {
    const migrationsDir = join(import.meta.dir, "../../migrations");
    const countBefore = (db.query("SELECT name FROM _migrations").all()).length;
    // Second run should be a no-op
    expect(() => runMigrations(db, migrationsDir)).not.toThrow();

    const rows = db.query("SELECT name FROM _migrations").all();
    expect(rows).toHaveLength(countBefore);
  });

  it("applies multiple migration files in order", () => {
    // Create a temp migrations dir with two files
    const tempDir = mkdtempSync(join(tmpdir(), "nx-mig-"));
    writeFileSync(
      join(tempDir, "001_first.sql"),
      "CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(
      join(tempDir, "002_second.sql"),
      "CREATE TABLE IF NOT EXISTS t2 (id INTEGER PRIMARY KEY);",
    );

    const freshDb = new Database(":memory:");
    runMigrations(freshDb, tempDir);

    const tables = freshDb
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('t1','t2') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(2);
    expect(tables[0]!.name).toBe("t1");
    expect(tables[1]!.name).toBe("t2");

    const applied = freshDb.query("SELECT name FROM _migrations ORDER BY id").all() as {
      name: string;
    }[];
    expect(applied).toHaveLength(2);
    expect(applied[0]!.name).toBe("001_first.sql");
    expect(applied[1]!.name).toBe("002_second.sql");

    freshDb.close();
  });
});

// ─── 7.2 Session CRUD ───────────────────────────────────────────────────────

describe("session CRUD", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts a session and retrieves it by id", () => {
    const session = makeSession();
    insertSession(db, session);

    const row = getSessionById(db, "sess-001");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("sess-001");
    expect(row!.project).toBe("nexus");
    expect(row!.machine).toBe("dev-1");
    expect(row!.status).toBe("active");
    expect(row!.pid).toBe(1234);
  });

  it("returns null for non-existent session id", () => {
    const row = getSessionById(db, "does-not-exist");
    expect(row).toBeNull();
  });

  it("updates session status", () => {
    insertSession(db, makeSession());

    updateSessionStatus(db, "sess-001", "idle");

    const row = getSessionById(db, "sess-001");
    expect(row!.status).toBe("idle");
    expect(row!.ended_at).toBeNull();
  });

  it("sets ended_at when status is 'ended'", () => {
    insertSession(db, makeSession());

    const endTime = new Date().toISOString();
    updateSessionStatus(db, "sess-001", "ended", endTime);

    const row = getSessionById(db, "sess-001");
    expect(row!.status).toBe("ended");
    expect(row!.ended_at).toBe(endTime);
  });

  it("queries active sessions (active + idle)", () => {
    insertSession(db, makeSession({ id: "s1", status: "active" }));
    insertSession(db, makeSession({ id: "s2", status: "idle" }));
    insertSession(db, makeSession({ id: "s3", status: "ended", ended_at: new Date().toISOString() }));

    const active = queryActiveSessions(db);
    expect(active).toHaveLength(2);

    const ids = active.map((s) => s.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).not.toContain("s3");
  });

  it("queries recent sessions within the time window", () => {
    const now = new Date();
    const recentTime = new Date(now.getTime() - 2 * 3600_000).toISOString(); // 2 hours ago
    const oldTime = new Date(now.getTime() - 48 * 3600_000).toISOString(); // 48 hours ago

    insertSession(
      db,
      makeSession({ id: "recent-1", last_activity: recentTime }),
    );
    insertSession(
      db,
      makeSession({ id: "old-1", last_activity: oldTime }),
    );

    const recent = queryRecentSessions(db, 24);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe("recent-1");
  });

  it("queryRecentSessions defaults to 24 hours", () => {
    const now = new Date();
    insertSession(
      db,
      makeSession({
        id: "s1",
        last_activity: new Date(now.getTime() - 12 * 3600_000).toISOString(),
      }),
    );
    insertSession(
      db,
      makeSession({
        id: "s2",
        last_activity: new Date(now.getTime() - 36 * 3600_000).toISOString(),
      }),
    );

    const recent = queryRecentSessions(db);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe("s1");
  });
});

// ─── 7.3 Health snapshots ────────────────────────────────────────────────────

describe("health snapshots", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts a health snapshot", () => {
    insertHealthSnapshot(db, {
      timestamp: new Date().toISOString(),
      cpu_percent: 42.5,
      ram_percent: 65.0,
      disk_percent: 80.1,
      docker_containers: 3,
      raw_json: JSON.stringify({ extra: "data" }),
    });

    const rows = db.query("SELECT * FROM health_snapshots").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].cpu_percent).toBe(42.5);
    expect(rows[0].ram_percent).toBe(65.0);
    expect(rows[0].docker_containers).toBe(3);
  });

  it("handles null metric fields", () => {
    insertHealthSnapshot(db, {
      timestamp: new Date().toISOString(),
      cpu_percent: null,
      ram_percent: null,
      disk_percent: null,
      docker_containers: null,
      raw_json: null,
    });

    const rows = db.query("SELECT * FROM health_snapshots").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].cpu_percent).toBeNull();
    expect(rows[0].raw_json).toBeNull();
  });

  it("queries time-series within the window, ordered ascending", () => {
    const now = new Date();

    // Insert 3 snapshots: 1h ago, 6h ago, 48h ago
    insertHealthSnapshot(db, {
      timestamp: new Date(now.getTime() - 1 * 3600_000).toISOString(),
      cpu_percent: 10,
      ram_percent: 20,
      disk_percent: 30,
      docker_containers: 1,
      raw_json: null,
    });
    insertHealthSnapshot(db, {
      timestamp: new Date(now.getTime() - 6 * 3600_000).toISOString(),
      cpu_percent: 20,
      ram_percent: 30,
      disk_percent: 40,
      docker_containers: 2,
      raw_json: null,
    });
    insertHealthSnapshot(db, {
      timestamp: new Date(now.getTime() - 48 * 3600_000).toISOString(),
      cpu_percent: 90,
      ram_percent: 90,
      disk_percent: 90,
      docker_containers: 10,
      raw_json: null,
    });

    // Query last 24 hours
    const series = queryHealthTimeSeries(db, 24);
    expect(series).toHaveLength(2);

    // Should be ascending by timestamp (6h ago first, then 1h ago)
    expect(series[0]!.cpu_percent).toBe(20);
    expect(series[1]!.cpu_percent).toBe(10);
  });

  it("queryHealthTimeSeries defaults to 24 hours", () => {
    const now = new Date();
    insertHealthSnapshot(db, {
      timestamp: new Date(now.getTime() - 12 * 3600_000).toISOString(),
      cpu_percent: 50,
      ram_percent: 50,
      disk_percent: 50,
      docker_containers: 0,
      raw_json: null,
    });
    insertHealthSnapshot(db, {
      timestamp: new Date(now.getTime() - 36 * 3600_000).toISOString(),
      cpu_percent: 99,
      ram_percent: 99,
      disk_percent: 99,
      docker_containers: 0,
      raw_json: null,
    });

    const series = queryHealthTimeSeries(db);
    expect(series).toHaveLength(1);
    expect(series[0]!.cpu_percent).toBe(50);
  });
});

// ─── 7.4 Session events ─────────────────────────────────────────────────────

describe("session events", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("appends an event and queries it back", () => {
    const ts = new Date().toISOString();
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "tool_call",
      timestamp: ts,
      metadata: JSON.stringify({ tool: "Read", duration_ms: 42 }),
    });

    const events = querySessionEvents(db, "sess-001");
    expect(events).toHaveLength(1);
    expect(events[0]!.session_id).toBe("sess-001");
    expect(events[0]!.event_type).toBe("tool_call");
    expect(events[0]!.timestamp).toBe(ts);
    expect(events[0]!.metadata).toBe(
      JSON.stringify({ tool: "Read", duration_ms: 42 }),
    );
  });

  it("handles null metadata", () => {
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "heartbeat",
      timestamp: new Date().toISOString(),
      metadata: null,
    });

    const events = querySessionEvents(db, "sess-001");
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toBeNull();
  });

  it("returns events ordered by timestamp ascending", () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-01T01:00:00.000Z";
    const t3 = "2026-01-01T02:00:00.000Z";

    // Insert out of order
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "end",
      timestamp: t3,
      metadata: null,
    });
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "start",
      timestamp: t1,
      metadata: null,
    });
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "tool_call",
      timestamp: t2,
      metadata: null,
    });

    const events = querySessionEvents(db, "sess-001");
    expect(events).toHaveLength(3);
    expect(events[0]!.event_type).toBe("start");
    expect(events[1]!.event_type).toBe("tool_call");
    expect(events[2]!.event_type).toBe("end");
  });

  it("filters events by session_id", () => {
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "start",
      timestamp: new Date().toISOString(),
      metadata: null,
    });
    appendSessionEvent(db, {
      session_id: "sess-002",
      event_type: "start",
      timestamp: new Date().toISOString(),
      metadata: null,
    });

    const events1 = querySessionEvents(db, "sess-001");
    expect(events1).toHaveLength(1);
    expect(events1[0]!.session_id).toBe("sess-001");

    const events2 = querySessionEvents(db, "sess-002");
    expect(events2).toHaveLength(1);
    expect(events2[0]!.session_id).toBe("sess-002");
  });
});

// ─── 7.5 Retention cleanup ──────────────────────────────────────────────────

describe("retention cleanup", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("deletes health_snapshots older than 30 days", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 10 * 86_400_000).toISOString(); // 10 days ago
    const stale = new Date(now.getTime() - 45 * 86_400_000).toISOString(); // 45 days ago

    insertHealthSnapshot(db, {
      timestamp: fresh,
      cpu_percent: 10,
      ram_percent: 10,
      disk_percent: 10,
      docker_containers: 0,
      raw_json: null,
    });
    insertHealthSnapshot(db, {
      timestamp: stale,
      cpu_percent: 99,
      ram_percent: 99,
      disk_percent: 99,
      docker_containers: 0,
      raw_json: null,
    });

    runRetentionCleanup(db);

    const rows = db.query("SELECT * FROM health_snapshots").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].cpu_percent).toBe(10);
  });

  it("deletes session_events older than 90 days", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 30 * 86_400_000).toISOString(); // 30 days ago
    const stale = new Date(now.getTime() - 100 * 86_400_000).toISOString(); // 100 days ago

    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "recent",
      timestamp: fresh,
      metadata: null,
    });
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "old",
      timestamp: stale,
      metadata: null,
    });

    runRetentionCleanup(db);

    const rows = db.query("SELECT * FROM session_events").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("recent");
  });

  it("keeps records within retention windows", () => {
    const now = new Date();
    const recentHealth = new Date(now.getTime() - 5 * 86_400_000).toISOString();
    const recentEvent = new Date(now.getTime() - 60 * 86_400_000).toISOString();

    insertHealthSnapshot(db, {
      timestamp: recentHealth,
      cpu_percent: 50,
      ram_percent: 50,
      disk_percent: 50,
      docker_containers: 1,
      raw_json: null,
    });
    appendSessionEvent(db, {
      session_id: "sess-001",
      event_type: "within_window",
      timestamp: recentEvent,
      metadata: null,
    });

    runRetentionCleanup(db);

    const healthRows = db.query("SELECT * FROM health_snapshots").all();
    expect(healthRows).toHaveLength(1);

    const eventRows = db.query("SELECT * FROM session_events").all();
    expect(eventRows).toHaveLength(1);
  });

  it("handles cleanup on empty tables without error", () => {
    expect(() => runRetentionCleanup(db)).not.toThrow();
  });
});
