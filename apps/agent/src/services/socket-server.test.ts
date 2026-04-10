import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import { startSocketServer, createSocketEventDispatcher } from "./socket-server";
import type { SocketEvent, SocketCommand, SocketResponse } from "../types/socket-events";
import type { SessionManager } from "../session-manager";
import type { WatcherEvent } from "@nexus/core";

// ---------------------------------------------------------------------------
// Module-level mocks for dispatch tests
// ---------------------------------------------------------------------------

mock.module("../notifications/channels/tts", () => ({
  sendTtsNotification: mock(() => Promise.resolve(true)),
}));

const mockRecordNotification = mock(() => {});
mock.module("./command-handler", () => ({
  recordNotification: mockRecordNotification,
  handleCommand: () => ({ error: "not implemented" }),
}));

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

const SOCKET_PATH = `/tmp/nexus-test-${process.pid}.sock`;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Helper: start a socket server with given handlers and return it. */
async function createTestServer(opts?: {
  onEvent?: (event: SocketEvent) => void;
  onCommand?: (cmd: SocketCommand) => SocketResponse | Promise<SocketResponse>;
}) {
  const server = await startSocketServer({
    socketPath: SOCKET_PATH,
    onEvent: opts?.onEvent ?? (() => {}),
    onCommand: opts?.onCommand ?? (() => ({ error: "not implemented" })),
  });
  cleanup = () => server.stop();
  return server;
}

/** Helper: connect to the test socket and send data (fire-and-forget events). */
async function sendToSocket(data: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let response = "";
    Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data(_socket, buf) {
          response += buf.toString();
        },
        open(socket) {
          socket.write(data);
          // Don't end() here -- let the server close the connection
          // if it needs to send a response (commands). For events,
          // end after a short delay to allow processing.
          socket.end();
        },
        close() {
          resolve(response);
        },
        error(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

/**
 * Helper: connect, send a command, and wait for the server's response.
 * The server writes a response line and then calls socket.end(), so we
 * wait for data and then close fires.
 */
async function sendCommand(data: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let response = "";
    Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data(_socket, buf) {
          response += buf.toString();
        },
        open(socket) {
          socket.write(data);
          // Do NOT end() -- let the server write a response and end the connection.
        },
        close() {
          resolve(response);
        },
        error(_socket, err) {
          reject(err);
        },
        connectError(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

/** Helper: connect, send data, and keep connection open until we manually close. */
async function sendRawChunks(chunks: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    Bun.connect({
      unix: SOCKET_PATH,
      socket: {
        data() {},
        async open(socket) {
          for (const chunk of chunks) {
            socket.write(chunk);
            // Small delay between chunks to ensure separate data events.
            await Bun.sleep(20);
          }
          socket.end();
        },
        close() {
          resolve();
        },
        error(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

describe("socket-server", () => {
  test("valid JSON event fires onEvent callback", async () => {
    const received: SocketEvent[] = [];

    await createTestServer({
      onEvent: (event) => {
        received.push(event);
      },
    });

    const event: SocketEvent = {
      event: "session_start",
      session_id: "test-123",
      project: "my-project",
    };

    await sendToSocket(JSON.stringify(event) + "\n");

    // Allow a tick for the handler to fire.
    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe("session_start");
    expect((received[0] as { session_id: string }).session_id).toBe("test-123");
  });

  test("line buffering: partial line then rest", async () => {
    const received: SocketEvent[] = [];

    await createTestServer({
      onEvent: (event) => {
        received.push(event);
      },
    });

    const event: SocketEvent = {
      event: "session_stop",
      session_id: "sess-partial",
    };
    const full = JSON.stringify(event);
    // Split in the middle of the JSON.
    const half = Math.floor(full.length / 2);
    const chunk1 = full.slice(0, half);
    const chunk2 = full.slice(half) + "\n";

    await sendRawChunks([chunk1, chunk2]);
    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe("session_stop");
  });

  test("invalid JSON does not crash the server", async () => {
    const received: SocketEvent[] = [];

    await createTestServer({
      onEvent: (event) => {
        received.push(event);
      },
    });

    // Send garbage, then a valid event.
    const validEvent: SocketEvent = {
      event: "session_heartbeat",
      session_id: "sess-after-garbage",
    };

    await sendRawChunks([
      "this is not json\n",
      JSON.stringify(validEvent) + "\n",
    ]);
    await Bun.sleep(50);

    // The valid event should still be processed after the garbage line.
    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe("session_heartbeat");
  });

  test("connection lifecycle: open, send, close", async () => {
    const received: SocketEvent[] = [];

    const server = await createTestServer({
      onEvent: (event) => {
        received.push(event);
      },
    });

    expect(server.path).toBe(SOCKET_PATH);

    // Send two events on the same connection.
    const event1: SocketEvent = {
      event: "session_start",
      session_id: "lc-1",
      project: "proj-a",
    };
    const event2: SocketEvent = {
      event: "session_stop",
      session_id: "lc-1",
    };

    await sendToSocket(
      JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n",
    );
    await Bun.sleep(50);

    expect(received).toHaveLength(2);
    expect(received[0]!.event).toBe("session_start");
    expect(received[1]!.event).toBe("session_stop");
  });

  test("command receives JSON response", async () => {
    await createTestServer({
      onCommand: (cmd) => {
        if (cmd.command === "mode_query") {
          return { mode: "full" };
        }
        return { error: "unknown command" };
      },
    });

    const command: SocketCommand = { command: "mode_query" };
    const raw = await sendCommand(JSON.stringify(command) + "\n");

    const response = JSON.parse(raw.trim());
    expect(response.mode).toBe("full");
  });

  test("server stop removes socket file", async () => {
    const server = await createTestServer();

    const { existsSync } = await import("node:fs");
    expect(existsSync(SOCKET_PATH)).toBe(true);

    server.stop();
    cleanup = null; // Already stopped.

    expect(existsSync(SOCKET_PATH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: built-in event dispatcher (ported from socket-dispatch.test.ts)
// ---------------------------------------------------------------------------

describe("socket-server event dispatcher", () => {
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let bus: import("./lifecycle-bus").LifecycleBus;
  let dispatch: (event: SocketEvent) => void;

  beforeEach(async () => {
    const { LifecycleBus } = await import("./lifecycle-bus");
    bus = new LifecycleBus();
    sessionManager = createMockSessionManager();
    dispatch = createSocketEventDispatcher({ sessionManager, lifecycleBus: bus });
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

  test("session_start emits SessionStarted on lifecycle bus", () => {
    const received: import("./lifecycle-bus").LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    dispatch({
      event: "session_start",
      session_id: "sess-bus-1",
      project: "nx",
      cwd: "/home/user/dev/nx",
      model: "opus",
    });

    const sessionEvents = received.filter((e) => e.event === "SessionStarted");
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]!.payload).toEqual({
      sessionId: "sess-bus-1",
      project: "nx",
      cwd: "/home/user/dev/nx",
      model: "opus",
    });
    expect(sessionEvents[0]!.source).toBe("local");
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

  test("session_stop emits SessionStopped on lifecycle bus", () => {
    const received: import("./lifecycle-bus").LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    dispatch({
      event: "session_stop",
      session_id: "sess-bus-2",
    });

    const stopEvents = received.filter((e) => e.event === "SessionStopped");
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0]!.payload).toEqual({ sessionId: "sess-bus-2" });
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

  test("session_heartbeat emits SessionHeartbeat on lifecycle bus", () => {
    const received: import("./lifecycle-bus").LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    dispatch({
      event: "session_heartbeat",
      session_id: "sess-bus-3",
    });

    const hbEvents = received.filter((e) => e.event === "SessionHeartbeat");
    expect(hbEvents).toHaveLength(1);
    const payload = hbEvents[0]!.payload as { sessionId: string; timestamp: string };
    expect(payload.sessionId).toBe("sess-bus-3");
    expect(payload.timestamp).toBeTruthy();
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

  test("notification event emits NotificationFired on lifecycle bus", () => {
    const received: import("./lifecycle-bus").LifecycleEnvelope[] = [];
    bus.onAny((env) => received.push(env));

    dispatch({
      event: "notification",
      message: "Build complete",
      channels: ["tts", "desktop"],
    } as unknown as SocketEvent);

    const notifEvents = received.filter((e) => e.event === "NotificationFired");
    expect(notifEvents).toHaveLength(1);
    const payload = notifEvents[0]!.payload as { message: string; channel: string };
    expect(payload.message).toBe("Build complete");
    expect(payload.channel).toBe("tts,desktop");
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
