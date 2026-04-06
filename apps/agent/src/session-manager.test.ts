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

  test("sweepIdle evicts ended sessions after TTL", () => {
    // Use a very short TTL (1 ms) so we can trigger eviction synchronously.
    manager = createSessionManager({ endedSessionTtlMs: 1 });

    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-evict",
      project: "test",
      path: "/tmp",
    });

    manager.handleWatcherEvent({
      type: "session_end",
      session_id: "sess-evict",
    });

    const session = manager.getById("sess-evict")!;
    expect(session.status).toBe("ended");

    // Backdate endedAt to ensure TTL has elapsed.
    const twoMsAgo = new Date(Date.now() - 2).toISOString();
    session.endedAt = twoMsAgo;

    manager.sweepIdle();

    // Session should have been evicted.
    expect(manager.getById("sess-evict")).toBeNull();
    expect(manager.getAll()).toHaveLength(0);
  });

  test("sweepIdle marks pre-existing idle sessions as stale after staleThresholdMs", () => {
    // Use a 1 ms stale threshold so we can trigger it synchronously.
    manager = createSessionManager({ staleThresholdMs: 1 });

    // Create a session and manually put it in idle state with an old heartbeat.
    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-stale",
      project: "test",
      path: "/tmp",
    });

    const session = manager.getById("sess-stale")!;
    // Backdate heartbeat so it's past both idle and stale thresholds.
    session.lastHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    // Manually set to idle (simulating a previous sweep).
    session.status = "idle";

    manager.sweepIdle();

    expect(manager.getById("sess-stale")!.status).toBe("stale");
  });

  test("sweepIdle does not mark freshly-idled sessions as stale in the same sweep", () => {
    // Use a 1 ms stale threshold.
    manager = createSessionManager({ staleThresholdMs: 1 });

    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-fresh-idle",
      project: "test",
      path: "/tmp",
    });

    const session = manager.getById("sess-fresh-idle")!;
    // Backdate heartbeat past idle threshold but the session was active before this sweep.
    session.lastHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    // Status is still "active" — sweep should transition active→idle but NOT idle→stale.
    expect(session.status).toBe("active");

    manager.sweepIdle();

    // Should be idle, not stale, because it was just transitioned this sweep.
    expect(manager.getById("sess-fresh-idle")!.status).toBe("idle");
  });

  test("sweepIdle does not evict ended sessions before TTL", () => {
    // Use a long TTL so eviction should not fire.
    manager = createSessionManager({ endedSessionTtlMs: 3_600_000 });

    manager.handleWatcherEvent({
      type: "session_start",
      session_id: "sess-keep",
      project: "test",
      path: "/tmp",
    });

    manager.handleWatcherEvent({
      type: "session_end",
      session_id: "sess-keep",
    });

    manager.sweepIdle();

    // Session should still be present.
    expect(manager.getById("sess-keep")).not.toBeNull();
    expect(manager.getById("sess-keep")!.status).toBe("ended");
  });
});
