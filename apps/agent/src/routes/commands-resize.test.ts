/**
 * Tests for POST /commands/resize — viewer-driven take-over resize.
 *
 * Spec: openspec/changes/pty-adaptive-geometry-fullscreen (nx-3bai2, task 3.2).
 *
 * Covers:
 *   1. managed session → 200, PTY.resize invoked, original geometry recorded
 *      in the take-over registry BEFORE the resize is applied.
 *   2. non-managed (ad_hoc) session → 409, PTY.resize NOT invoked.
 *   3. invalid dims (cols=0, rows out of range, non-integer) → 400, NOT invoked.
 *   4. unknown session → 404. (boundary check between 400 dims-gate and the
 *      managed gate.)
 *
 * The route is decoupled from tmux: it talks to a `PtySource` via the
 * `geometry()` / `resize()` interface and to the in-memory take-over registry.
 * We therefore drive it with a stub StreamManager whose PTY records resize
 * calls and reports a known geometry — no tmux subprocess is spawned. The
 * SessionManager is a minimal stub matching the shape `handleResize` reads.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { SessionManager } from "../session-manager";
import type { StreamManager } from "../terminal/stream-manager";
import type { PtySource } from "../terminal/pty-source";
import {
  hasTakeover,
  getTakeoverGeometry,
  __resetTakeoverRegistry,
} from "../terminal/takeover-registry";
import {
  initResizeRoute,
  handleResize,
  resetResizeRoute,
} from "./commands-resize";

// ── Stub PtySource — records resize calls + reports a fixed geometry ──────────

class SpyPty implements PtySource {
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  constructor(
    private readonly _geom: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ) {}
  onData(): () => void {
    return () => {};
  }
  getScrollback(): string[] {
    return [];
  }
  write(): void {}
  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }
  geometry(): { cols: number; rows: number } {
    return { ...this._geom };
  }
  close(): void {}
}

// ── Stub SessionManager / StreamManager ───────────────────────────────────────

type FakeSession = { id: string; sessionType: "ad_hoc" | "managed" | "pooled" };

function makeSessionManagerStub(
  sessions: Record<string, FakeSession>,
): SessionManager {
  return {
    getById: (id: string) => (sessions[id] ?? null) as never,
  } as unknown as SessionManager;
}

function makeStreamManagerStub(ptys: Record<string, PtySource>): StreamManager {
  return {
    getPty: (id: string) => ptys[id],
  } as unknown as StreamManager;
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:7400/commands/resize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ──

describe("POST /commands/resize", () => {
  beforeEach(() => {
    __resetTakeoverRegistry();
    resetResizeRoute();
  });

  test("managed session resizes the pane AND records original geometry", async () => {
    const sid = "cc-managed-1";
    // Original pane geometry the source reports BEFORE the resize.
    const pty = new SpyPty({ cols: 120, rows: 40 });
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "managed" } }),
      makeStreamManagerStub({ [sid]: pty }),
    );

    const res = await handleResize(
      makeRequest({ sessionId: sid, cols: 200, rows: 60 }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cols: number; rows: number };
    expect(body.ok).toBe(true);
    expect(body.cols).toBe(200);
    expect(body.rows).toBe(60);

    // The pane was resized to the viewer's grid.
    expect(pty.resizeCalls).toEqual([{ cols: 200, rows: 60 }]);

    // Take-over was marked so the WS teardown path unsets window-size on last
    // viewer disconnect (no recorded geometry — tmux re-fits, nx-cjhfv).
    expect(hasTakeover(sid)).toBe(true);
  });

  test("take-over flag is idempotent across repeated resizes", async () => {
    const sid = "cc-managed-2";
    const pty = new SpyPty({ cols: 100, rows: 30 });
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "managed" } }),
      makeStreamManagerStub({ [sid]: pty }),
    );

    await handleResize(makeRequest({ sessionId: sid, cols: 150, rows: 50 }));
    await handleResize(makeRequest({ sessionId: sid, cols: 180, rows: 55 }));

    // Two resizes applied...
    expect(pty.resizeCalls).toEqual([
      { cols: 150, rows: 50 },
      { cols: 180, rows: 55 },
    ]);
    // ...and the take-over flag remains set (idempotent).
    expect(hasTakeover(sid)).toBe(true);
  });

  test("non-managed (ad_hoc) session is rejected with 409 and does NOT resize", async () => {
    const sid = "cc-adhoc-1";
    const pty = new SpyPty();
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "ad_hoc" } }),
      makeStreamManagerStub({ [sid]: pty }),
    );

    const res = await handleResize(
      makeRequest({ sessionId: sid, cols: 120, rows: 40 }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("managed");

    // Critical: no resize, no take-over flag for a non-managed session.
    expect(pty.resizeCalls.length).toBe(0);
    expect(hasTakeover(sid)).toBe(false);
  });

  test("invalid dims (cols=0) rejected with 400 before any gating", async () => {
    const sid = "cc-managed-3";
    const pty = new SpyPty();
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "managed" } }),
      makeStreamManagerStub({ [sid]: pty }),
    );

    const res = await handleResize(
      makeRequest({ sessionId: sid, cols: 0, rows: 40 }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("range");
    expect(pty.resizeCalls.length).toBe(0);
    expect(hasTakeover(sid)).toBe(false);
  });

  test("invalid dims (rows above max) rejected with 400", async () => {
    const sid = "cc-managed-4";
    const pty = new SpyPty();
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "managed" } }),
      makeStreamManagerStub({ [sid]: pty }),
    );

    const res = await handleResize(
      makeRequest({ sessionId: sid, cols: 80, rows: 99999 }),
    );

    expect(res.status).toBe(400);
    expect(pty.resizeCalls.length).toBe(0);
  });

  test("non-integer dims rejected with 400", async () => {
    const sid = "cc-managed-5";
    const pty = new SpyPty();
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "managed" } }),
      makeStreamManagerStub({ [sid]: pty }),
    );

    const res = await handleResize(
      makeRequest({ sessionId: sid, cols: 80.5, rows: 24 }),
    );

    expect(res.status).toBe(400);
    expect(pty.resizeCalls.length).toBe(0);
  });

  test("unresolved session (cache miss) + no PTY defers with 202 and records geometry", async () => {
    // mx-rkir.12: `getById` returns null on a read-through cache MISS for a
    // process-watcher-discovered session that lives only in the DB. The phone's
    // resize POST can land in that window AND before its /stream WS attaches the
    // PTY. We must NOT 404/409 — we record the geometry and defer (202) so the
    // stream-attach path re-applies it once the PTY is live.
    initResizeRoute(
      makeSessionManagerStub({}),
      makeStreamManagerStub({}),
    );

    const res = await handleResize(
      makeRequest({ sessionId: "cc-deferred-1", cols: 57, rows: 54 }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; deferred: boolean };
    expect(body.ok).toBe(true);
    expect(body.deferred).toBe(true);

    // Geometry recorded so addViewer can replay it on attach.
    expect(hasTakeover("cc-deferred-1")).toBe(true);
    expect(getTakeoverGeometry("cc-deferred-1")).toEqual({ cols: 57, rows: 54 });
  });

  test("managed session with no PTY yet defers with 202 (resize replayed on attach)", async () => {
    const sid = "cc-managed-deferred";
    initResizeRoute(
      makeSessionManagerStub({ [sid]: { id: sid, sessionType: "managed" } }),
      makeStreamManagerStub({}), // no PTY attached
    );

    const res = await handleResize(
      makeRequest({ sessionId: sid, cols: 57, rows: 54 }),
    );

    expect(res.status).toBe(202);
    expect(getTakeoverGeometry(sid)).toEqual({ cols: 57, rows: 54 });
  });
});
