import { describe, test, expect, afterEach } from "bun:test";
import { startSocketServer } from "./socket-server";
import type { SocketEvent, SocketCommand, SocketResponse } from "../types/socket-events";

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
