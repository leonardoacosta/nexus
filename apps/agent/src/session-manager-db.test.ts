/**
 * Session manager write-through / read-through integration tests.
 *
 * [2.1] Session start event -> appears in both Map and DB
 * [2.2] PID validation: dead PID -> marked ended on init
 * [2.3] Graceful degradation: DB failure -> session still in Map
 */

import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { createSessionManager } from "./session-manager";
import type { SessionManager } from "./session-manager";
import type { WatcherEvent, Session } from "@nexus/core";
import * as sessionsDb from "./db/sessions";

// ── Mock DB helpers ────────────────────────────────────────────────────────

/** Sessions stored in the mock DB, keyed by ID. */
let mockStore: Map<string, Session>;

/**
 * Whether the mock DB should reject writes.
 * Set to `true` to simulate DB failure for graceful degradation tests.
 */
let mockDbShouldFail = false;

/** Error log capture for assertion. */
let capturedErrors: Array<{ id: string; error: string }> = [];

/**
 * Create a minimal mock Db proxy that stubs upsertSession and
 * loadActiveSessions via module-level mocks.
 */
function createTestDb(): any {
  // The mock DB is a simple proxy — the real work is done by mocking
  // the sessionsDb module functions below.
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "select") {
          return () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
                orderBy: () => Promise.resolve([]),
              }),
              limit: () => Promise.resolve([]),
              orderBy: () => Promise.resolve([]),
            }),
          });
        }
        if (prop === "insert") {
          return () => ({
            values: () => ({
              onConflictDoUpdate: () => {
                if (mockDbShouldFail) {
                  return Promise.reject(new Error("mock DB write failure"));
                }
                return Promise.resolve();
              },
            }),
          });
        }
        if (prop === "update") {
          return () => ({
            set: () => ({
              where: () => Promise.resolve(),
            }),
          });
        }
        return () => new Proxy({}, { get: () => () => ({}) });
      },
    },
  );
}

// ── Module-level mocks ─────────────────────────────────────────────────────

// We mock the DB functions at the module level so the session-manager
// calls our stubs instead of hitting a real Postgres connection.

let upsertSpy: ReturnType<typeof spyOn>;
let loadSpy: ReturnType<typeof spyOn>;

function setupMocks() {
  mockStore = new Map();
  mockDbShouldFail = false;
  capturedErrors = [];

  // Mock upsertSession: store to mockStore (or reject if shouldFail)
  upsertSpy = spyOn(sessionsDb, "upsertSession").mockImplementation(
    async (_db: any, session: Session) => {
      if (mockDbShouldFail) {
        throw new Error("mock DB write failure");
      }
      mockStore.set(session.id, { ...session });
    },
  );

  // Mock loadActiveSessions: return sessions from mockStore
  loadSpy = spyOn(sessionsDb, "loadActiveSessions").mockImplementation(
    async (_db: any) => {
      return Array.from(mockStore.values()).filter((s) => s.endedAt === null);
    },
  );
}

function teardownMocks() {
  upsertSpy?.mockRestore();
  loadSpy?.mockRestore();
}

// ── Tests ──────────────────────────────────────────────────────────────────

let manager: SessionManager;

afterEach(() => {
  manager?.stop();
  teardownMocks();
});

describe("session-manager write-through (with mock DB)", () => {
  test("[2.1] session_start event appears in both Map and DB", async () => {
    setupMocks();
    const db = createTestDb();
    manager = createSessionManager({ db });

    const event: WatcherEvent = {
      type: "session_start",
      session_id: "wt-sess-1",
      project: "test-project",
      path: "/tmp/test",
    };

    manager.handleWatcherEvent(event);

    // Session should be in the Map immediately
    const fromMap = manager.getById("wt-sess-1");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.status).toBe("active");
    expect(fromMap!.project).toBe("test-project");

    // Wait for async DB write to settle
    await new Promise((r) => setTimeout(r, 50));

    // Verify upsertSession was called
    expect(upsertSpy).toHaveBeenCalled();

    // Verify the session was written to the mock store
    const fromDb = mockStore.get("wt-sess-1");
    expect(fromDb).not.toBeUndefined();
    expect(fromDb!.id).toBe("wt-sess-1");
    expect(fromDb!.status).toBe("active");
    expect(fromDb!.project).toBe("test-project");
  });

  test("[2.1] session_end event updates both Map and DB", async () => {
    setupMocks();
    const db = createTestDb();
    manager = createSessionManager({ db });

    // Start a session
    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "wt-sess-end",
      project: "test",
      path: "/tmp",
    });

    await new Promise((r) => setTimeout(r, 50));

    // End the session
    manager.handleWatcherEvent({
      type: "session_end",
      session_id: "wt-sess-end",
    });

    // Check Map
    const fromMap = manager.getById("wt-sess-end");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.status).toBe("ended");
    expect(fromMap!.endedAt).not.toBeNull();

    // Wait for async DB write
    await new Promise((r) => setTimeout(r, 50));

    // Check mock store
    const fromDb = mockStore.get("wt-sess-end");
    expect(fromDb).not.toBeUndefined();
    expect(fromDb!.status).toBe("ended");
    expect(fromDb!.endedAt).not.toBeNull();
  });

  test("[2.1] session_update event updates both Map and DB", async () => {
    setupMocks();
    const db = createTestDb();
    manager = createSessionManager({ db });

    // Start a session
    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "wt-sess-upd",
      project: "test",
      path: "/tmp",
    });

    await new Promise((r) => setTimeout(r, 50));

    const newTimestamp = new Date().toISOString();
    manager.handleWatcherEvent({
      type: "session_update",
      session_id: "wt-sess-upd",
      timestamp: newTimestamp,
    });

    // Check Map
    const fromMap = manager.getById("wt-sess-upd");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.lastHeartbeat).toEqual(new Date(newTimestamp));

    // Wait for async DB write
    await new Promise((r) => setTimeout(r, 50));

    // Check mock store — should have been written
    const fromDb = mockStore.get("wt-sess-upd");
    expect(fromDb).not.toBeUndefined();
  });

  test("[2.1] init recovers sessions from DB on startup", async () => {
    setupMocks();

    // Pre-populate mock store with a session
    const existingSession: Session = {
      id: "recovered-sess",
      pid: process.pid, // use current PID so it passes validation
      project: "recovered-project",
      machine: "test-machine",
      cwd: "/tmp/recovered",
      branch: null,
      startedAt: new Date(),
      lastHeartbeat: new Date(),
      endedAt: null,
      status: "active",
      spec: null,
      command: null,
      agent: null,
      tmuxSession: null,
      ccSessionId: null,
      tmuxTarget: null,
      rateLimitUtilization: null,
      rateLimitType: null,
      totalCostUsd: null,
      model: null,
      sessionType: "ad_hoc",
    };
    mockStore.set("recovered-sess", existingSession);

    const db = createTestDb();
    manager = createSessionManager({ db });
    await manager.init();

    // Session should be loaded into the Map
    const fromMap = manager.getById("recovered-sess");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.project).toBe("recovered-project");
    expect(fromMap!.status).toBe("active");
    expect(manager.getAll()).toHaveLength(1);
  });
});

describe("session-manager PID validation", () => {
  test("[2.2] dead PID is marked ended on init", async () => {
    setupMocks();

    // Pre-populate mock store with a session whose PID doesn't exist
    const deadPidSession: Session = {
      id: "dead-pid-sess",
      pid: 999999, // very unlikely to be a real PID
      project: "test",
      machine: "test-machine",
      cwd: "/tmp",
      branch: null,
      startedAt: new Date(),
      lastHeartbeat: new Date(),
      endedAt: null,
      status: "active",
      spec: null,
      command: null,
      agent: null,
      tmuxSession: null,
      ccSessionId: null,
      tmuxTarget: null,
      rateLimitUtilization: null,
      rateLimitType: null,
      totalCostUsd: null,
      model: null,
      sessionType: "ad_hoc",
    };
    mockStore.set("dead-pid-sess", deadPidSession);

    const db = createTestDb();
    manager = createSessionManager({ db });
    await manager.init();

    // Session should be in the Map but marked as ended
    const fromMap = manager.getById("dead-pid-sess");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.status).toBe("ended");
    expect(fromMap!.endedAt).not.toBeNull();

    // Wait for async DB write
    await new Promise((r) => setTimeout(r, 50));

    // Verify upsertSession was called to update DB with ended status
    expect(upsertSpy).toHaveBeenCalled();
    const dbSession = mockStore.get("dead-pid-sess");
    expect(dbSession).not.toBeUndefined();
    expect(dbSession!.status).toBe("ended");
    expect(dbSession!.endedAt).not.toBeNull();
  });

  test("[2.2] live PID remains active on init", async () => {
    setupMocks();

    // Use current process PID — it's definitely alive
    const livePidSession: Session = {
      id: "live-pid-sess",
      pid: process.pid,
      project: "test",
      machine: "test-machine",
      cwd: "/tmp",
      branch: null,
      startedAt: new Date(),
      lastHeartbeat: new Date(),
      endedAt: null,
      status: "active",
      spec: null,
      command: null,
      agent: null,
      tmuxSession: null,
      ccSessionId: null,
      tmuxTarget: null,
      rateLimitUtilization: null,
      rateLimitType: null,
      totalCostUsd: null,
      model: null,
      sessionType: "ad_hoc",
    };
    mockStore.set("live-pid-sess", livePidSession);

    const db = createTestDb();
    manager = createSessionManager({ db });
    await manager.init();

    const fromMap = manager.getById("live-pid-sess");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.status).toBe("active");
    expect(fromMap!.endedAt).toBeNull();
  });
});

describe("session-manager graceful degradation", () => {
  test("[2.3] session still appears in Map when DB write fails", async () => {
    setupMocks();
    mockDbShouldFail = true;

    const db = createTestDb();
    manager = createSessionManager({ db });

    // Send a session_start event — DB write will fail
    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "degraded-sess",
      project: "test",
      path: "/tmp",
    });

    // Session should still be in the Map (graceful degradation)
    const fromMap = manager.getById("degraded-sess");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.status).toBe("active");
    expect(fromMap!.project).toBe("test");

    // Wait for async DB write to settle (and fail)
    await new Promise((r) => setTimeout(r, 50));

    // upsertSession was called but should have thrown
    expect(upsertSpy).toHaveBeenCalled();

    // The session should NOT be in the mock store (write failed)
    expect(mockStore.has("degraded-sess")).toBe(false);
  });

  test("[2.3] subsequent events still work after DB failure", async () => {
    setupMocks();
    mockDbShouldFail = true;

    const db = createTestDb();
    manager = createSessionManager({ db });

    // Start a session (DB fails)
    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "degraded-multi",
      project: "test",
      path: "/tmp",
    });

    // Heartbeat (DB fails)
    manager.handleWatcherEvent({
      type: "session_update",
      session_id: "degraded-multi",
      timestamp: new Date().toISOString(),
    });

    // End (DB fails)
    manager.handleWatcherEvent({
      type: "session_end",
      session_id: "degraded-multi",
    });

    // All state should still be tracked in Map
    const fromMap = manager.getById("degraded-multi");
    expect(fromMap).not.toBeNull();
    expect(fromMap!.status).toBe("ended");
    expect(fromMap!.endedAt).not.toBeNull();
  });
});
