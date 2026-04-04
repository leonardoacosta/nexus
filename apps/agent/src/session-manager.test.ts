import { describe, test, expect, afterEach } from "bun:test";
import { createSessionManager } from "./session-manager";
import type { WatcherEvent } from "@nexus/core";

let manager: ReturnType<typeof createSessionManager>;

afterEach(() => {
  manager?.stop();
});

describe("session-manager", () => {
  test("session_start creates session with status active", () => {
    manager = createSessionManager();

    const event: WatcherEvent = {
      type: "session_start",
      session_id: "sess-1",
      project: "my-project",
      path: "/home/user/dev/my-project",
    };

    manager.handleWatcherEvent(event);

    const session = manager.getById("sess-1");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("active");
    expect(session!.project).toBe("my-project");
    expect(session!.cwd).toBe("/home/user/dev/my-project");
    expect(session!.id).toBe("sess-1");
    expect(session!.endedAt).toBeNull();

    // Should appear in getAll and getActive
    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getActive()).toHaveLength(1);
  });

  test("sweepIdle marks session as idle when last_activity > 5 min ago", () => {
    manager = createSessionManager();

    // Create a session
    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-idle",
      project: "test",
      path: "/tmp",
    });

    // Manually backdate lastHeartbeat to 6 minutes ago
    const session = manager.getById("sess-idle")!;
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    session.lastHeartbeat = sixMinutesAgo;

    manager.sweepIdle();

    expect(manager.getById("sess-idle")!.status).toBe("idle");
    // Idle sessions still appear in getActive (they're not ended)
    expect(manager.getActive()).toHaveLength(1);
  });

  test("session_end sets status to ended and records endedAt", () => {
    manager = createSessionManager();

    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-end",
      project: "test",
      path: "/tmp",
    });

    expect(manager.getById("sess-end")!.status).toBe("active");

    manager.handleWatcherEvent({
      type: "session_end",
      session_id: "sess-end",
    });

    const session = manager.getById("sess-end")!;
    expect(session.status).toBe("ended");
    expect(session.endedAt).not.toBeNull();

    // Ended sessions should not appear in getActive
    expect(manager.getActive()).toHaveLength(0);
    // But still in getAll
    expect(manager.getAll()).toHaveLength(1);
  });

  test("session_update refreshes lastHeartbeat and reactivates idle sessions", () => {
    manager = createSessionManager();

    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-update",
      project: "test",
      path: "/tmp",
    });

    // Backdate and mark idle
    const session = manager.getById("sess-update")!;
    session.lastHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    manager.sweepIdle();
    expect(session.status).toBe("idle");

    // Now send an update event — should reactivate
    const newTimestamp = new Date().toISOString();
    manager.handleWatcherEvent({
      type: "session_update",
      session_id: "sess-update",
      timestamp: newTimestamp,
    });

    expect(session.status).toBe("active");
    expect(session.lastHeartbeat).toBe(newTimestamp);
  });

  test("getById returns null for unknown session", () => {
    manager = createSessionManager();
    expect(manager.getById("nonexistent")).toBeNull();
  });
});
