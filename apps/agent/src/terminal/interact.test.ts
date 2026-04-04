import { describe, expect, it, afterAll, beforeAll, afterEach } from "bun:test";
import { startServer, healthCollector, streamManager } from "../server";
import { MockPtySource } from "./pty-source";

const server = startServer(0);
const baseUrl = `http://localhost:${server.port}`;
const wsUrl = `ws://localhost:${server.port}`;

afterAll(() => {
  streamManager.shutdown();
  healthCollector.stop();
  server.stop();
});

// Helper: connect a WebSocket and collect events
function connectWs(
  path: string,
): Promise<{
  ws: WebSocket;
  messages: (string | Uint8Array)[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}> {
  const ws = new WebSocket(`${wsUrl}${path}`);
  ws.binaryType = "arraybuffer";
  const messages: (string | Uint8Array)[] = [];

  const opened = new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve());
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (ev) => {
      resolve({ code: ev.code, reason: ev.reason });
    });
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      messages.push(ev.data);
    } else if (ev.data instanceof ArrayBuffer) {
      messages.push(new Uint8Array(ev.data));
    }
  });

  return Promise.resolve({ ws, messages, opened, closed });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uint8ToString(data: string | Uint8Array): string {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(data);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WebSocket interact: /sessions/{id}/interact", () => {
  const SESSION_ID = "test-interact-session";
  let pty: MockPtySource;

  beforeAll(() => {
    pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(SESSION_ID, pty);
  });

  afterAll(() => {
    streamManager.endSession(SESSION_ID);
  });

  it("[4.1] sends input bytes, receives echo on stdout (bidirectional I/O)", async () => {
    const { ws, messages, opened } = await connectWs(`/sessions/${SESSION_ID}/interact`);
    await opened;

    // Clear scrollback messages from initial connect
    await delay(20);
    const initialCount = messages.length;

    // Send raw bytes
    const input = new TextEncoder().encode("hello world");
    ws.send(input);

    await delay(50);

    // MockPtySource echoes writes back to subscribers
    const newMsgs = messages.slice(initialCount);
    const text = newMsgs.map(uint8ToString).join("");
    expect(text).toContain("hello world");

    ws.close();
    await delay(20);
  });

  it("[4.1b] handles control characters transparently (raw bytes pass through)", async () => {
    // Need a fresh session for a clean writer mutex
    const sid = "test-interact-ctrl";
    const ctrlPty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, ctrlPty);

    const { ws, messages, opened } = await connectWs(`/sessions/${sid}/interact`);
    await opened;
    await delay(20);
    const initialCount = messages.length;

    // Send Ctrl+C (0x03) and Ctrl+D (0x04) as binary
    ws.send(new Uint8Array([0x03, 0x04]));

    await delay(50);

    const newMsgs = messages.slice(initialCount);
    // The mock echoes back the bytes
    const allBytes: number[] = [];
    for (const m of newMsgs) {
      if (m instanceof Uint8Array) {
        for (const b of m) allBytes.push(b);
      }
    }
    expect(allBytes).toContain(0x03);
    expect(allBytes).toContain(0x04);

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  });

  it("[4.2] resize event triggers resize on PTY", async () => {
    const sid = "test-interact-resize";
    const resizePty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, resizePty);

    const { ws, opened } = await connectWs(`/sessions/${sid}/interact`);
    await opened;

    // Send resize JSON control frame
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    await delay(50);

    expect(resizePty.lastResize).toEqual({ cols: 120, rows: 40 });

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  });
});

describe("WebSocket interact: mutex", () => {
  const SESSION_ID = "test-interact-mutex";
  let pty: MockPtySource;

  beforeAll(() => {
    pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(SESSION_ID, pty);
  });

  afterAll(() => {
    streamManager.endSession(SESSION_ID);
  });

  it("[4.3] second interactive client is rejected with 4009", async () => {
    // First writer connects
    const { ws: writer1, opened: open1 } = await connectWs(`/sessions/${SESSION_ID}/interact`);
    await open1;

    await delay(20);

    // Second writer tries to connect
    const { ws: writer2, closed: closed2 } = await connectWs(`/sessions/${SESSION_ID}/interact`);

    const closeResult = await closed2;
    expect(closeResult.code).toBe(4009);
    expect(closeResult.reason).toContain("already held");

    writer1.close();
    await delay(20);
  });

  it("[4.4] writer disconnect releases mutex for next client", async () => {
    // Connect a stream viewer to observe the writer_disconnected event
    const { ws: viewer, messages: viewerMsgs, opened: viewerOpened } =
      await connectWs(`/sessions/${SESSION_ID}/stream`);
    await viewerOpened;
    await delay(20);

    // Connect first writer
    const sid2 = "test-interact-mutex-release";
    const pty2 = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid2, pty2);

    const { ws: writer1, opened: open1 } = await connectWs(`/sessions/${sid2}/interact`);
    await open1;
    await delay(20);

    // Disconnect writer1
    writer1.close();
    await delay(50);

    // Second writer should now succeed
    const { ws: writer2, messages: msgs2, opened: open2 } = await connectWs(`/sessions/${sid2}/interact`);
    await open2;

    // Verify it actually connected and can send data
    writer2.send(new TextEncoder().encode("after-release"));
    await delay(50);

    const text = msgs2.map(uint8ToString).join("");
    expect(text).toContain("after-release");

    writer2.close();
    viewer.close();
    await delay(20);
    streamManager.endSession(sid2);
  });
});

describe("WebSocket interact: invalid session", () => {
  it("returns 404 for non-existent session", async () => {
    const res = await fetch(`${baseUrl}/sessions/nonexistent/interact`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("session not found");
  });
});
