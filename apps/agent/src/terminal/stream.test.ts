import { describe, expect, it, afterAll, beforeAll, afterEach } from "bun:test";
import { startServer, healthCollector, streamManager } from "../server";
import { MockPtySource } from "./pty-source";

const ATTACH_SECRET = process.env.NEXUS_ATTACH_SECRET ?? "test";

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
  const ws = new WebSocket(
    `${wsUrl}${path}`,
    { headers: { "x-nexus-secret": ATTACH_SECRET } } as unknown as string,
  );
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

describe("WebSocket stream: /sessions/{id}/stream", () => {
  // Each test uses its own session ID to avoid cross-test state contamination
  // (the PTY orphan fix tears down the session when the last viewer disconnects).

  it("[4.1] connects, receives output, and verifies frame ordering", async () => {
    const sid = "stream-order-test";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws, messages, opened } = await connectWs(`/sessions/${sid}/stream`);
    await opened;

    // Emit some lines
    pty.emit("line-1\n");
    pty.emit("line-2\n");
    pty.emit("line-3\n");

    await delay(50);

    // Should have received the lines in order
    const text = messages.map(uint8ToString).join("");
    expect(text).toContain("line-1");
    expect(text).toContain("line-2");
    expect(text).toContain("line-3");
    expect(text.indexOf("line-1")).toBeLessThan(text.indexOf("line-2"));
    expect(text.indexOf("line-2")).toBeLessThan(text.indexOf("line-3"));

    ws.close();
    await delay(20);
  });

  it("[4.2] multiple viewers receive the same output", async () => {
    const sid = "stream-broadcast-test";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws: ws1, messages: msgs1, opened: open1 } = await connectWs(`/sessions/${sid}/stream`);
    const { ws: ws2, messages: msgs2, opened: open2 } = await connectWs(`/sessions/${sid}/stream`);

    await Promise.all([open1, open2]);

    pty.emit("broadcast-test\n");

    await delay(50);

    const text1 = msgs1.map(uint8ToString).join("");
    const text2 = msgs2.map(uint8ToString).join("");

    expect(text1).toContain("broadcast-test");
    expect(text2).toContain("broadcast-test");

    ws1.close();
    await delay(20);
    ws2.close();
    await delay(20);
  });

  it("[4.3] late-joining client receives scrollback buffer", async () => {
    const sid = "stream-scrollback-test";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    // Emit lines before connecting
    for (let i = 0; i < 5; i++) {
      pty.emit(`scrollback-${i}\n`);
    }

    await delay(20);

    const { ws, messages, opened } = await connectWs(`/sessions/${sid}/stream`);
    await opened;

    // Wait for scrollback delivery
    await delay(50);

    const text = messages.map(uint8ToString).join("");

    // Should contain scrollback lines
    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`scrollback-${i}`);
    }

    ws.close();
    await delay(20);
  });
});

describe("WebSocket stream: invalid session", () => {
  it("[1.2] returns 404 for non-existent session", async () => {
    // Attempt HTTP upgrade on unknown session — server returns 404 before upgrade
    const res = await fetch(`${baseUrl}/sessions/nonexistent/stream`, {
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("session not found");
  });
});

// ── Task 7.2: Scrollback join fix ───────────────────────────────────────────

describe("Scrollback join fix (task 7)", () => {
  it("[7.2] scrollback line ending with \\n does not produce double newline on replay", async () => {
    const sid = "scrollback-join-test";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    // Emit a line; MockPtySource.emit splits on \n and stores lines without trailing \n
    pty.emit("exactly-one-newline\n");
    await delay(20);

    const { ws, messages, opened } = await connectWs(`/sessions/${sid}/stream`);
    await opened;
    await delay(50);

    const text = messages.map(uint8ToString).join("");
    // The scrollback replay should contain exactly one newline after the line
    const occurrences = (text.match(/exactly-one-newline\n/g) ?? []).length;
    expect(occurrences).toBe(1);
    // No double newline
    expect(text).not.toContain("exactly-one-newline\n\n");

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  });
});

describe("WebSocket stream: session end", () => {
  const SESSION_ID = "test-stream-end";

  it("[3.2] sends session_ended control frame on session end", async () => {
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(SESSION_ID, pty);

    const { ws, messages, opened, closed } = await connectWs(`/sessions/${SESSION_ID}/stream`);
    await opened;

    await delay(20);

    // End the session
    streamManager.endSession(SESSION_ID);

    const closeResult = await closed;
    expect(closeResult.code).toBe(1000);

    // Should have received a session_ended JSON control frame
    const textMsgs = messages.filter((m) => typeof m === "string");
    const controlFrame = textMsgs.find((m) => {
      try {
        return JSON.parse(m as string).type === "session_ended";
      } catch {
        return false;
      }
    });
    expect(controlFrame).toBeDefined();
  });
});
