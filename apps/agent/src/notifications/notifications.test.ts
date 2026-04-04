import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { runMigrations } from "../db/migrate";
import {
  insertNotification,
  queryNotificationsByStatus,
  markNotificationDelivered,
  markNotificationExpired,
  getNotificationById,
} from "./buffer";
import type { NotificationRow } from "./buffer";
import { MeetingState } from "./meeting-state";
import { NotificationManager } from "./manager";
import {
  findMatchingRule,
  setRoutingRules,
  routeNotification,
} from "./router";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function makeNotification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "notif-001",
    channel: "desktop",
    title: "Test Notification",
    body: "This is a test notification body",
    project: null,
    priority: "normal",
    status: "queued",
    created_at: new Date().toISOString(),
    sent_at: null,
    ...overrides,
  };
}

// ─── Buffer CRUD ──────────────────────────────────────────────────────────────

describe("notification buffer", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts a notification and retrieves it by id", () => {
    const notif = makeNotification();
    insertNotification(db, notif);

    const row = getNotificationById(db, "notif-001");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("notif-001");
    expect(row!.channel).toBe("desktop");
    expect(row!.title).toBe("Test Notification");
    expect(row!.status).toBe("queued");
  });

  it("queries notifications by status", () => {
    insertNotification(db, makeNotification({ id: "n1", status: "queued" }));
    insertNotification(db, makeNotification({ id: "n2", status: "queued" }));
    insertNotification(db, makeNotification({ id: "n3", status: "delivered" }));

    const queued = queryNotificationsByStatus(db, "queued");
    expect(queued).toHaveLength(2);

    const delivered = queryNotificationsByStatus(db, "delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.id).toBe("n3");
  });

  it("marks a notification as delivered", () => {
    insertNotification(db, makeNotification({ id: "n1" }));

    markNotificationDelivered(db, "n1");

    const row = getNotificationById(db, "n1");
    expect(row!.status).toBe("delivered");
    expect(row!.sent_at).not.toBeNull();
  });

  it("marks a notification as expired", () => {
    insertNotification(db, makeNotification({ id: "n1" }));

    markNotificationExpired(db, "n1");

    const row = getNotificationById(db, "n1");
    expect(row!.status).toBe("expired");
  });

  it("returns null for non-existent notification", () => {
    const row = getNotificationById(db, "does-not-exist");
    expect(row).toBeNull();
  });

  it("returns queued notifications ordered by created_at ascending", () => {
    insertNotification(
      db,
      makeNotification({ id: "n1", created_at: "2026-01-01T02:00:00.000Z" }),
    );
    insertNotification(
      db,
      makeNotification({ id: "n2", created_at: "2026-01-01T01:00:00.000Z" }),
    );
    insertNotification(
      db,
      makeNotification({ id: "n3", created_at: "2026-01-01T03:00:00.000Z" }),
    );

    const queued = queryNotificationsByStatus(db, "queued");
    expect(queued[0]!.id).toBe("n2");
    expect(queued[1]!.id).toBe("n1");
    expect(queued[2]!.id).toBe("n3");
  });
});

// ─── Meeting state ────────────────────────────────────────────────────────────

describe("meeting state", () => {
  it("starts inactive", () => {
    const state = new MeetingState();
    expect(state.active).toBe(false);
    expect(state.startedAt).toBeNull();
  });

  it("toggles meeting on and off", () => {
    const state = new MeetingState();

    state.start();
    expect(state.active).toBe(true);
    expect(state.startedAt).not.toBeNull();

    state.end();
    expect(state.active).toBe(false);
    expect(state.startedAt).toBeNull();
  });

  it("returns status object", () => {
    const state = new MeetingState();
    const status = state.status();
    expect(status).toEqual({ active: false, started_at: null });

    state.start();
    const activeStatus = state.status();
    expect(activeStatus.active).toBe(true);
    expect(typeof activeStatus.started_at).toBe("string");
  });
});

// ─── Buffer/flush lifecycle ───────────────────────────────────────────────────

describe("notification manager — buffer/flush lifecycle", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
    // Reset routing rules to default for each test
    setRoutingRules([]);
  });
  afterEach(() => {
    db.close();
  });

  it("delivers notification immediately when not in a meeting", async () => {
    const manager = new NotificationManager(db);

    const result = await manager.send({
      id: "n1",
      channel: "desktop",
      title: "Test",
      body: "Body",
      project: null,
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    expect(result.status).toBe("delivered");

    const row = getNotificationById(db, "n1");
    expect(row!.status).toBe("delivered");
    expect(row!.sent_at).not.toBeNull();
  });

  it("buffers notifications during a meeting", async () => {
    const manager = new NotificationManager(db);
    manager.startMeeting();

    const result = await manager.send({
      id: "n1",
      channel: "desktop",
      title: "Test",
      body: "Body",
      project: null,
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    expect(result.status).toBe("queued");

    const row = getNotificationById(db, "n1");
    expect(row!.status).toBe("queued");
    expect(row!.sent_at).toBeNull();
  });

  it("flushes buffered notifications when meeting ends", async () => {
    const manager = new NotificationManager(db);
    manager.startMeeting();

    // Queue notifications during meeting
    await manager.send({
      id: "n1",
      channel: "desktop",
      title: "Test 1",
      body: "Body 1",
      project: null,
      priority: "normal",
      created_at: new Date().toISOString(),
    });
    await manager.send({
      id: "n2",
      channel: "desktop",
      title: "Test 2",
      body: "Body 2",
      project: null,
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    // Both should be queued
    expect(queryNotificationsByStatus(db, "queued")).toHaveLength(2);
    expect(queryNotificationsByStatus(db, "delivered")).toHaveLength(0);

    // End meeting — flush
    const flushed = await manager.endMeeting();
    expect(flushed).toBe(2);

    // Both should now be delivered
    expect(queryNotificationsByStatus(db, "queued")).toHaveLength(0);
    expect(queryNotificationsByStatus(db, "delivered")).toHaveLength(2);
  });

  it("drops notifications during meeting when rule says drop", async () => {
    setRoutingRules([
      { project: "noisy-project", channels: ["desktop"], meeting_behavior: "drop" },
    ]);

    const manager = new NotificationManager(db);
    manager.startMeeting();

    const result = await manager.send({
      id: "n1",
      channel: "desktop",
      title: "Noisy",
      body: "Dropped during meeting",
      project: "noisy-project",
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    expect(result.status).toBe("expired");

    const row = getNotificationById(db, "n1");
    expect(row!.status).toBe("expired");
  });

  it("allows notifications during meeting when rule says allow", async () => {
    setRoutingRules([
      { project: "critical-project", channels: ["desktop"], meeting_behavior: "allow" },
    ]);

    const manager = new NotificationManager(db);
    manager.startMeeting();

    const result = await manager.send({
      id: "n1",
      channel: "desktop",
      title: "Critical",
      body: "Allowed during meeting",
      project: "critical-project",
      priority: "high",
      created_at: new Date().toISOString(),
    });

    expect(result.status).toBe("delivered");
  });
});

// ─── Delivery channels (mocked) ──────────────────────────────────────────────

describe("delivery channels", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
    setRoutingRules([]);
  });
  afterEach(() => {
    db.close();
  });

  it("desktop channel succeeds", async () => {
    const { sendDesktopNotification } = await import("./channels/desktop");
    const notif = makeNotification();
    const result = await sendDesktopNotification(notif);
    expect(result).toBe(true);
  });

  it("tts channel succeeds (stub mode without API key)", async () => {
    const { sendTtsNotification } = await import("./channels/tts");
    const notif = makeNotification();
    const result = await sendTtsNotification(notif);
    expect(result).toBe(true);
  });

  it("slack channel succeeds (stub mode without webhook URL)", async () => {
    const { sendSlackNotification } = await import("./channels/slack");
    const notif = makeNotification();
    const result = await sendSlackNotification(notif);
    expect(result).toBe(true);
  });
});

// ─── Project-aware routing ────────────────────────────────────────────────────

describe("project-aware routing", () => {
  beforeEach(() => {
    setRoutingRules([]);
  });

  it("uses default rule when no project rules are set", () => {
    const notif = makeNotification({ project: "some-project" });
    const rule = findMatchingRule(notif);
    expect(rule.channels).toEqual(["desktop"]);
    expect(rule.meeting_behavior).toBe("buffer");
  });

  it("matches project-specific rule", () => {
    setRoutingRules([
      { project: "co", channels: ["desktop", "slack"], meeting_behavior: "buffer" },
      { project: "nx", channels: ["tts"], meeting_behavior: "allow" },
    ]);

    const notif = makeNotification({ project: "nx" });
    const rule = findMatchingRule(notif);
    expect(rule.channels).toEqual(["tts"]);
    expect(rule.meeting_behavior).toBe("allow");
  });

  it("falls back to wildcard rule when no project match", () => {
    setRoutingRules([
      { project: "co", channels: ["desktop", "slack"], meeting_behavior: "buffer" },
      { channels: ["desktop"], meeting_behavior: "drop" },
    ]);

    const notif = makeNotification({ project: "unknown-project" });
    const rule = findMatchingRule(notif);
    expect(rule.channels).toEqual(["desktop"]);
    expect(rule.meeting_behavior).toBe("drop");
  });

  it("routes notification to multiple channels", async () => {
    setRoutingRules([
      { project: "co", channels: ["desktop", "tts", "slack"], meeting_behavior: "buffer" },
    ]);

    const notif = makeNotification({ project: "co" });
    const results = await routeNotification(notif);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.map((r) => r.channel)).toEqual(["desktop", "tts", "slack"]);
  });
});
