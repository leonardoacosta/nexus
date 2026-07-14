import { describe, expect, it, afterAll, beforeAll, afterEach } from "bun:test";
import { MockPtySource } from "./pty-source";
import type { PtySource } from "./pty-source";

// Bind the SHARED @nexus/core/node logger spy (nx-509z5) BEFORE importing
// `../server`. `../server` transitively loads cross-machine-delivery.ts, which
// binds its `log` at module-load via createLogger(). A STATIC import of
// `../server` (which this file used to have) loads that chain with the REAL
// pino logger — and because this suite often wins the load-order race in the
// full run, cross-machine-delivery.test.ts's `loggerSpy.warn` assertions then
// read 0 calls. A top-level-await dynamic import after the mock fixes it.
const { installCoreNodeMock } = await import("../testing/mock-core-node");
installCoreNodeMock({ mockGetAgentId: false });
const { startServer, healthCollector, streamManager } = await import("../server");

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
  // Each test uses its own session ID — the PTY orphan fix tears down the session
  // when the last viewer disconnects, so shared sessions cause cross-test interference.

  it("[4.3] second interactive client EVICTS the prior holder (symmetric last-open-wins)", async () => {
    // ios-session-navigation: the newest interact opener WINS the writer mutex;
    // the prior holder is evicted with 4009 (not the new opener refused).
    const sid = "test-interact-mutex-evict";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    // First writer connects and holds the mutex.
    const { ws: writer1, opened: open1, closed: closed1 } = await connectWs(
      `/sessions/${sid}/interact`,
    );
    await open1;

    await delay(20);

    // Second writer opens — it should SUCCEED, and writer1 should be evicted 4009.
    const { ws: writer2, opened: open2 } = await connectWs(`/sessions/${sid}/interact`);
    await open2; // the new opener is NOT refused

    const evicted = await closed1;
    expect(evicted.code).toBe(4009);
    expect(evicted.reason).toContain("reclaimed");

    writer2.close();
    await delay(20);
  });

  it("[4.4] writer disconnect releases mutex for next client", async () => {
    // Connect first writer to its own session
    const sid = "test-interact-mutex-release";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws: writer1, opened: open1 } = await connectWs(`/sessions/${sid}/interact`);
    await open1;
    await delay(20);

    // Disconnect writer1 — but we need the session to stay alive for writer2.
    // Add a stream viewer as an anchor before disconnecting writer1.
    const { ws: anchor, opened: anchorOpen } = await connectWs(`/sessions/${sid}/stream`);
    await anchorOpen;
    await delay(20);

    writer1.close();
    await delay(50);

    // Second writer should now succeed (mutex was released)
    const { ws: writer2, messages: msgs2, opened: open2 } = await connectWs(`/sessions/${sid}/interact`);
    await open2;

    // Verify it actually connected and can send data
    writer2.send(new TextEncoder().encode("after-release"));
    await delay(50);

    const text = msgs2.map(uint8ToString).join("");
    expect(text).toContain("after-release");

    writer2.close();
    anchor.close();
    await delay(20);
  });
});

// ── Task 4.1: interact binary frame never dropped for a claimed writer ───────
//
// Regression guard for nx-qq3qu / nx-uql03. The underlying interact-channel bug
// was fixed client-side in f2e99d20 (iOS PtyInteractChannel no longer markReadOnly
// on a benign geometry broadcast). This test locks the AGENT-side receive contract
// that keystrokes depend on: for a socket that holds the writer mutex, EVERY binary
// interact frame reaches `pty.write()` — none is rejected as "not the interactive
// writer" and none takes the `DROPPED — no PTY attached` branch (there is always a
// PTY here, and the byte-exact capture proves each frame landed).
//
// A `RecordingPtySource` records every write() call so we can assert byte-for-byte
// that N repeated keystroke frames produce N writes with the exact bytes, i.e. zero
// drops.

class RecordingPtySource implements PtySource {
  readonly writes: Uint8Array[] = [];
  private listeners = new Set<(d: Uint8Array) => void>();
  private _cols = 80;
  private _rows = 24;
  private closed = false;

  onData(cb: (d: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getScrollback(): string[] {
    return [];
  }
  write(data: Uint8Array): void {
    if (this.closed) return;
    // Copy — the caller may reuse the backing buffer.
    this.writes.push(new Uint8Array(data));
    // Echo so viewer machinery behaves like the real/mock source.
    for (const cb of this.listeners) {
      try {
        cb(data);
      } catch {
        // ignore
      }
    }
  }
  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
  }
  geometry(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }
  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

describe("WebSocket interact: binary frame delivery (task 4.1, nx-qq3qu regression)", () => {
  it("[4.1] every repeated binary keystroke from the writer reaches pty.write(), zero drops", async () => {
    const sid = "test-interact-no-drop";
    const rec = new RecordingPtySource();
    streamManager.attach(sid, rec);

    const { ws, messages, opened } = await connectWs(`/sessions/${sid}/interact`);
    await opened;
    // Let the open() writer-claim settle before sending input.
    await delay(20);

    // Simulate repeated keystrokes: N discrete single-byte binary frames, the
    // exact shape the iOS PtyInteractChannel sends per keypress.
    const keystrokes = [..."echo hi\r"].map((c) => c.charCodeAt(0));
    for (const code of keystrokes) {
      ws.send(new Uint8Array([code]));
    }

    await delay(80);

    // Each keystroke frame produced exactly one pty.write() with the right byte.
    expect(rec.writes.length).toBe(keystrokes.length);
    const flattened = rec.writes.map((w) => w[0]);
    expect(flattened).toEqual(keystrokes);

    // No frame was rejected as "not the interactive writer" — the writer mutex
    // held for the whole burst.
    const errorFrames = messages.filter((m) => {
      if (typeof m !== "string") return false;
      try {
        return JSON.parse(m).type === "error";
      } catch {
        return false;
      }
    });
    expect(errorFrames).toEqual([]);

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
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

// ── Task 1.2: PTY orphan fix tests ─────────────────────────────────────────

describe("PTY lifecycle: orphan fix (task 1.1)", () => {
  it("[1.2a] session stays live when one of two viewers disconnects", async () => {
    const sid = "pty-orphan-two-viewers";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws: viewer1, opened: open1 } = await connectWs(`/sessions/${sid}/stream`);
    const { ws: viewer2, opened: open2 } = await connectWs(`/sessions/${sid}/stream`);
    await Promise.all([open1, open2]);
    await delay(20);

    // Disconnect viewer1 — session should still be live (viewer2 remains)
    viewer1.close();
    await delay(50);

    expect(streamManager.getPty(sid)).toBeDefined();
    expect(streamManager.viewerCount(sid)).toBe(1);

    viewer2.close();
    await delay(50);
    // Cleanup: session may already be ended by close handler
  });

  it("[1.2b] session is torn down when last viewer disconnects", async () => {
    const sid = "pty-orphan-last-viewer";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws, opened } = await connectWs(`/sessions/${sid}/stream`);
    await opened;
    await delay(20);

    expect(streamManager.getPty(sid)).toBeDefined();

    ws.close();
    await delay(100);

    // After the last viewer disconnects, endSession should have been called
    expect(streamManager.getPty(sid)).toBeUndefined();
    expect(streamManager.viewerCount(sid)).toBe(0);
  });
});

// ── Task 3.4: Reconnect / replay integration test ──────────────────────────

describe("Reconnect: replay buffer (task 3)", () => {
  it("[3.4] reconnecting viewer receives buffered output from the gap", async () => {
    const sid = "reconnect-replay-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    // Connect TWO viewers — one anchor (stays connected) and one that disconnects.
    // The anchor keeps the session alive while viewer1 is gone, so we can test
    // reconnect replay without the session being torn down.
    const { ws: anchor, opened: anchorOpen } = await connectWs(`/sessions/${sid}/stream`);
    await anchorOpen;

    const { ws: viewer1, opened: open1 } = await connectWs(`/sessions/${sid}/stream`);
    await open1;

    pty.emit("line-before-disconnect\n");
    await delay(30);

    // Disconnect viewer1 — anchor keeps session alive
    viewer1.close();
    await delay(30);

    // Emit more lines while viewer1 is disconnected — these go into lastOutput buffer
    pty.emit("missed-line-1\n");
    pty.emit("missed-line-2\n");
    await delay(20);

    // viewer1 reconnects
    const { ws: viewer2, messages: msgs2, opened: open2 } = await connectWs(
      `/sessions/${sid}/stream`,
    );
    await open2;
    await delay(20);

    // Send reconnect frame to get the buffer replayed
    viewer2.send(JSON.stringify({ type: "reconnect", sessionId: sid }));
    await delay(50);

    const text = msgs2.map((m) =>
      typeof m === "string" ? m : new TextDecoder().decode(m),
    ).join("");

    // Should contain missed lines from the reconnect buffer
    expect(text).toContain("missed-line-1");
    expect(text).toContain("missed-line-2");

    // Should also see replay_done sentinel
    const hasReplayDone = msgs2.some((m) => {
      if (typeof m !== "string") return false;
      try {
        return JSON.parse(m).type === "replay_done";
      } catch {
        return false;
      }
    });
    expect(hasReplayDone).toBe(true);

    viewer2.close();
    anchor.close();
    await delay(50);
  });
});
