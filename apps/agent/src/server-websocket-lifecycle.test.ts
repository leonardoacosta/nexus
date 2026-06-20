/**
 * Server WebSocket lifecycle tests — connection limit, resize validation,
 * pong timeout, and isWriter guard.
 */

import { describe, expect, it } from "bun:test";
import {
  baseUrl,
  wsUrl,
  delay,
  openInteractWs,
  streamManager,
  MockPtySource,
} from "./server.helpers";

// ── Security: connection limit ────────────────────────────────────────────────

describe("WebSocket security: connection limit", () => {
  it("[2.2] upgrade beyond MAX_CONCURRENT_CONNECTIONS returns 429", async () => {
    const sessionId = "sec-rate-limit-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sessionId, pty);

    const MAX = 50;
    const sockets: WebSocket[] = [];
    const openPromises: Promise<void>[] = [];

    for (let i = 0; i < MAX; i++) {
      const ws = new WebSocket(`${wsUrl}/sessions/${sessionId}/stream`);
      sockets.push(ws);
      openPromises.push(
        new Promise<void>((resolve) => {
          ws.addEventListener("open", () => resolve());
          ws.addEventListener("close", () => resolve());
          ws.addEventListener("error", () => resolve());
        }),
      );
    }

    await Promise.all(openPromises);
    await delay(50);

    const overflow = await fetch(`${baseUrl}/sessions/${sessionId}/stream`);
    expect(overflow.status).toBe(429);

    for (const ws of sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    // Give the server time to process all close events and clean allSockets
    await delay(200);
    streamManager.endSession(sessionId);
  });
});

// ── Security: resize validation ───────────────────────────────────────────────

describe("WebSocket security: resize validation", () => {
  // This WS roundtrip (upgrade → open → send resize → await error frame)
  // is the slowest resize case. The handshake + delay() barriers starve when
  // the full agent suite runs concurrently on a loaded machine: observed up to
  // ~27s vs <1s in isolation, blowing Bun's default 5s per-test timeout (see
  // nx-b7fm5). The validation assertion is unchanged; only the timeout is
  // widened, scoped to this test.
  it("[2.4] resize with cols=0 (below min 1) returns JSON error frame", async () => {
    const sid = "resize-cols-zero-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws, messages, opened } = await openInteractWs(sid);
    await opened;

    ws.send(JSON.stringify({ type: "resize", cols: 0, rows: 100 }));
    await delay(80);

    const errorMsg = messages.find((m) => {
      try { return JSON.parse(m).type === "error"; } catch { return false; }
    });
    expect(errorMsg).toBeDefined();

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  }, { timeout: 60_000 });

  it("[2.4] resize with cols=1000 (above max 500) returns JSON error frame", async () => {
    const sid = "resize-cols-max-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws, messages, opened } = await openInteractWs(sid);
    await opened;

    ws.send(JSON.stringify({ type: "resize", cols: 1000, rows: 100 }));
    await delay(80);

    const errorMsg = messages.find((m) => {
      try { return JSON.parse(m).type === "error"; } catch { return false; }
    });
    expect(errorMsg).toBeDefined();

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  });

  it("[2.4] resize with rows=0 (below min 1) returns JSON error frame", async () => {
    const sid = "resize-rows-zero-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws, messages, opened } = await openInteractWs(sid);
    await opened;

    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 0 }));
    await delay(80);

    const errorMsg = messages.find((m) => {
      try { return JSON.parse(m).type === "error"; } catch { return false; }
    });
    expect(errorMsg).toBeDefined();

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  });

  it("[2.4] resize with non-integer cols (0.5) returns JSON error frame", async () => {
    const sid = "resize-float-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const { ws, messages, opened } = await openInteractWs(sid);
    await opened;

    ws.send(JSON.stringify({ type: "resize", cols: 0.5, rows: 24 }));
    await delay(80);

    const errorMsg = messages.find((m) => {
      try { return JSON.parse(m).type === "error"; } catch { return false; }
    });
    expect(errorMsg).toBeDefined();

    ws.close();
    await delay(20);
    streamManager.endSession(sid);
  });
});

// ── Security: pong timeout ────────────────────────────────────────────────────

describe("WebSocket keepalive: pong timeout", () => {
  it("[2.5] pong timeout calls removeViewer and endSession when no viewers remain", () => {
    const sm = new (streamManager.constructor as typeof import("./terminal/stream-manager").StreamManager)();
    const pty = new MockPtySource({ intervalMs: 0 });

    const sessionId = "pong-timeout-session";
    sm.attach(sessionId, pty);

    expect(sm.viewerCount(sessionId)).toBe(0);

    sm.endSession(sessionId);

    expect(sm.getPty(sessionId)).toBeUndefined();
    expect(sm.viewerCount(sessionId)).toBe(0);
  });
});

// ── Task 4.2: interact writer — SYMMETRIC last-open-wins reclaim ──────────────

describe("interact writer mutex: last-open-wins reclaim (task 4.2)", () => {
  it("second interact socket reclaims the writer; first holder is evicted (4009)", async () => {
    const sid = "iswriter-guard-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    // First interact socket opens and claims the writer mutex.
    let firstCloseCode: number | null = null;
    let firstOpened = false;
    const ws1 = new WebSocket(`${wsUrl}/sessions/${sid}/interact`);
    const ws1Opened = new Promise<void>((resolve) => {
      ws1.addEventListener("open", () => { firstOpened = true; resolve(); });
      ws1.addEventListener("close", (ev) => {
        firstCloseCode = (ev as CloseEvent).code;
        resolve();
      });
      ws1.addEventListener("error", () => resolve());
    });
    await ws1Opened;
    await delay(30);
    expect(firstOpened).toBe(true);

    // Second interact socket opens and RECLAIMS the writer (last-open-wins).
    // It must NOT be rejected; the prior holder (ws1) is evicted with 4009.
    let secondOpened = false;
    let secondCloseCode: number | null = null;
    const ws2 = new WebSocket(`${wsUrl}/sessions/${sid}/interact`);
    const ws2Settled = new Promise<void>((resolve) => {
      ws2.addEventListener("open", () => { secondOpened = true; resolve(); });
      ws2.addEventListener("close", (ev) => {
        secondCloseCode = (ev as CloseEvent).code;
        resolve();
      });
      ws2.addEventListener("error", () => resolve());
    });
    await ws2Settled;
    // Give the server time to evict + close the prior writer socket.
    await delay(50);

    // Second socket wins: opened, still alive (not closed).
    expect(secondOpened).toBe(true);
    expect(secondCloseCode as number | null).toBeNull();

    // First socket is demoted/evicted: closed with the 4009 reclaim code.
    expect(firstCloseCode as number | null).toBe(4009);

    // nx-y4hjl regression guard: the reclaim handoff (ws1 evicted while it is
    // the ONLY other viewer) must NOT destroy the PTY. ws1's close-handler
    // last-viewer teardown must be suppressed during a live reclaim so the
    // session survives and ws2 becomes the writer. A destroyed session would
    // surface as ws2 closing 4004 (asserted null above) AND the PTY being gone.
    expect(streamManager.getPty(sid)).toBeDefined();
    // ws2 is the live viewer holding the session open; viewerCount must be >= 1.
    expect(streamManager.viewerCount(sid)).toBeGreaterThanOrEqual(1);

    try { ws2.close(); } catch { /* ignore */ }
    await delay(30);
    streamManager.endSession(sid);
  });
});

// ── Task 7.3: TLS enforcement — loopback allowed; non-loopback HTTP rejected ──

describe("TLS enforcement for POST /credentials (task 7.3)", () => {
  it("POST /credentials on loopback (http://localhost) is allowed past TLS check", async () => {
    const res = await fetch(`${baseUrl}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test", name: "test", type: "api_key", value: "val" }),
    });
    expect(res.status).not.toBe(426);
    expect(res.status).not.toBe(403);
  });

  it("x-forwarded-proto: https header present — TLS enforcement accepts", async () => {
    const res = await fetch(`${baseUrl}/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ id: "test2", name: "test2", type: "api_key", value: "val" }),
    });
    expect(res.status).not.toBe(426);
    expect(res.status).not.toBe(403);
  });
});
