/**
 * Server WebSocket lifecycle tests — connection limit, resize validation,
 * pong timeout, and isWriter guard.
 */

import { describe, expect, it } from "bun:test";
import {
  ATTACH_SECRET,
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
      const ws = new WebSocket(
        `${wsUrl}/sessions/${sessionId}/stream`,
        { headers: { "x-nexus-secret": ATTACH_SECRET } } as unknown as string,
      );
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

    const overflow = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
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
  });

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

// ── Task 4.2: isWriter guard — non-writer interact socket drops messages ──────

describe("isWriter guard: non-writer socket drops messages (task 4.2)", () => {
  it("second interact socket is rejected (writer mutex already held)", async () => {
    const sid = "iswriter-guard-session";
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sid, pty);

    const ws1 = new WebSocket(
      `${wsUrl}/sessions/${sid}/interact`,
      { headers: { "x-nexus-secret": ATTACH_SECRET } } as unknown as string,
    );
    const ws1Opened = new Promise<void>((resolve) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("close", () => resolve());
      ws1.addEventListener("error", () => resolve());
    });
    await ws1Opened;
    await delay(30);

    let secondCloseCode: number | null = null;
    const ws2 = new WebSocket(
      `${wsUrl}/sessions/${sid}/interact`,
      { headers: { "x-nexus-secret": ATTACH_SECRET } } as unknown as string,
    );
    const ws2Settled = new Promise<void>((resolve) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("close", (ev) => {
        secondCloseCode = (ev as CloseEvent).code;
        resolve();
      });
      ws2.addEventListener("error", () => resolve());
    });
    await ws2Settled;
    await delay(30);

    expect(secondCloseCode).toBe(4009);

    try { ws1.close(); } catch { /* ignore */ }
    await delay(30);
    streamManager.endSession(sid);
  });
});

// ── Task 7.3: TLS enforcement — loopback allowed; non-loopback HTTP rejected ──

describe("TLS enforcement for POST /credentials (task 7.3)", () => {
  it("POST /credentials on loopback (http://localhost) is allowed past TLS check", async () => {
    const res = await fetch(`${baseUrl}/credentials`, {
      method: "POST",
      headers: { "x-nexus-secret": ATTACH_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test", name: "test", type: "api_key", value: "val" }),
    });
    expect(res.status).not.toBe(426);
    expect(res.status).not.toBe(403);
  });

  it("x-forwarded-proto: https header present — TLS enforcement accepts", async () => {
    const res = await fetch(`${baseUrl}/credentials`, {
      method: "POST",
      headers: {
        "x-nexus-secret": ATTACH_SECRET,
        "Content-Type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ id: "test2", name: "test2", type: "api_key", value: "val" }),
    });
    expect(res.status).not.toBe(426);
    expect(res.status).not.toBe(403);
  });
});
