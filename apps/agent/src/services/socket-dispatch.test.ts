import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createSocketEventHandler } from "./socket-dispatch";
import type { SessionManager } from "../session-manager";
import type { WatcherEvent } from "@nexus/core";
import type { SocketEvent } from "../types/socket-events";

// ---------------------------------------------------------------------------
// Mock SessionManager
// ---------------------------------------------------------------------------

function createMockSessionManager(): SessionManager & {
  receivedEvents: WatcherEvent[];
} {
  const receivedEvents: WatcherEvent[] = [];

  return {
    receivedEvents,
    handleWatcherEvent(event: WatcherEvent) {
      receivedEvents.push(event);
    },
    getAll: () => [],
    getActive: () => [],
    getById: () => null,
    sweepIdle: () => {},
    stop: () => {},
  };
}

// ---------------------------------------------------------------------------
// Mock TTS and recordNotification (module-level mocks)
// ---------------------------------------------------------------------------

// Mock the TTS module to avoid real API calls.
mock.module("../notifications/channels/tts", () => ({
  sendTtsNotification: mock(() => Promise.resolve(true)),
}));

// Mock the command handler to capture recordNotification calls.
const mockRecordNotification = mock(() => {});
mock.module("./command-handler", () => ({
  recordNotification: mockRecordNotification,
}));

describe("socket-dispatch", () => {
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let dispatch: (event: SocketEvent) => void;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    dispatch = createSocketEventHandler({ sessionManager });
    mockRecordNotification.mockClear();
  });

  test("session_start routes to sessionManager.handleWatcherEvent", () => {
    const event: SocketEvent = {
      event: "session_start",
      session_id: "sess-abc",
      project: "my-project",
      cwd: "/home/user/dev/my-project",
      model: "opus",
    };

    dispatch(event);

    expect(sessionManager.receivedEvents).toHaveLength(1);
    const wEvent = sessionManager.receivedEvents[0]!;
    expect(wEvent.type).toBe("session_start");
    expect(wEvent.session_id).toBe("sess-abc");
    if (wEvent.type === "session_start") {
      expect(wEvent.project).toBe("my-project");
      expect(wEvent.path).toBe("/home/user/dev/my-project");
    }
  });

  test("session_stop routes to sessionManager.handleWatcherEvent", () => {
    const event: SocketEvent = {
      event: "session_stop",
      session_id: "sess-stop-1",
    };

    dispatch(event);

    expect(sessionManager.receivedEvents).toHaveLength(1);
    const wEvent = sessionManager.receivedEvents[0]!;
    expect(wEvent.type).toBe("session_end");
    expect(wEvent.session_id).toBe("sess-stop-1");
  });

  test("session_heartbeat routes to sessionManager.handleWatcherEvent", () => {
    const event: SocketEvent = {
      event: "session_heartbeat",
      session_id: "sess-hb",
    };

    dispatch(event);

    expect(sessionManager.receivedEvents).toHaveLength(1);
    const wEvent = sessionManager.receivedEvents[0]!;
    expect(wEvent.type).toBe("session_update");
    expect(wEvent.session_id).toBe("sess-hb");
  });

  test("notification event calls recordNotification", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "Build succeeded",
      message_type: "brief",
      channels: ["tts", "desktop"],
    };

    dispatch(event);

    expect(mockRecordNotification).toHaveBeenCalledTimes(1);
    expect(mockRecordNotification).toHaveBeenCalledWith(
      "Build succeeded",
      "brief",
      ["tts", "desktop"],
    );
  });

  test("notification event defaults channels to [tts]", () => {
    const event: SocketEvent = {
      event: "notification",
      message: "Hello world",
    };

    dispatch(event);

    expect(mockRecordNotification).toHaveBeenCalledWith(
      "Hello world",
      "brief",
      ["tts"],
    );
  });

  test("session events do not affect notification channel", () => {
    dispatch({
      event: "session_start",
      session_id: "sess-no-notif",
      project: "test",
    });

    expect(mockRecordNotification).not.toHaveBeenCalled();
  });

  test("agent_spawn does not crash (log-only event)", () => {
    // Should not throw.
    dispatch({
      event: "agent_spawn",
      session_id: "sess-spawn",
      agent_type: "engineer",
      model: "sonnet",
    });

    expect(sessionManager.receivedEvents).toHaveLength(0);
  });

  test("agent_complete does not crash (log-only event)", () => {
    dispatch({
      event: "agent_complete",
      session_id: "sess-done",
      agent_type: "engineer",
      duration_ms: 5000,
    });

    expect(sessionManager.receivedEvents).toHaveLength(0);
  });

  test("telemetry event does not crash", () => {
    dispatch({
      event: "telemetry",
      payload: { tokens: 1234, model: "opus" },
    });

    expect(sessionManager.receivedEvents).toHaveLength(0);
  });

  test("multiple events dispatch independently", () => {
    dispatch({
      event: "session_start",
      session_id: "multi-1",
      project: "proj",
    });

    dispatch({
      event: "session_heartbeat",
      session_id: "multi-1",
    });

    dispatch({
      event: "session_stop",
      session_id: "multi-1",
    });

    expect(sessionManager.receivedEvents).toHaveLength(3);
    expect(sessionManager.receivedEvents[0]!.type).toBe("session_start");
    expect(sessionManager.receivedEvents[1]!.type).toBe("session_update");
    expect(sessionManager.receivedEvents[2]!.type).toBe("session_end");
  });
});
