/**
 * Tests for PTY geometry control frame at attach (task 3.1) and take-over
 * auto-restore on last-viewer disconnect (task 3.3).
 *
 * Spec: openspec/changes/pty-adaptive-geometry-fullscreen (nx-3bai2).
 *
 * 3.1 — StreamManager.addViewer emits a `{"type":"geometry","cols":N,"rows":N}`
 *       TEXT control frame carrying the source's pane geometry, BEFORE the
 *       binary scrollback. We drive a fake viewer socket that captures every
 *       sendText / sendBinary call and assert the frame shape + ordering.
 *
 * 3.3 — The WS teardown path (createWsHandlers().close) restores the original
 *       pane geometry when the LAST take-over viewer disconnects, and leaves a
 *       never-resized session's pane untouched. We use a tmux-like spy PtySource
 *       (implements restoreGeometry / restoreWindowSize / onGeometryChange) so
 *       the restore is observable without spawning real tmux.
 *
 * No tmux subprocess and no DB are involved — these are pure unit tests against
 * the terminal + websocket lifecycle layers.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { StreamManager, type WsData } from "./stream-manager";
import type { PtySource } from "./pty-source";
import {
  createWsHandlers,
  type ServerState,
} from "../server-websocket";
import {
  recordOriginalGeometry,
  __resetTakeoverRegistry,
  hasTakeover,
} from "./takeover-registry";

// ── Stub ServerState ──────────────────────────────────────────────────────────
// `createWsHandlers`/`maybeRestoreTakeover` only read `streamManager`,
// `allSockets`, `pongDeadlines`, and call `startPingTimer`/`stopPingTimer`. A
// structural stub with a REAL StreamManager avoids `ServerState.create()`, which
// spins up a HealthCollector that polls the Docker socket (unhandled rejection
// on machines without Docker — the source of the health-collector flake).
function makeStubState(): {
  state: ServerState;
  streamManager: StreamManager;
} {
  const streamManager = new StreamManager();
  const stub = {
    streamManager,
    allSockets: new Set<ServerWebSocket<WsData>>(),
    pongDeadlines: new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>(),
    startPingTimer: () => {},
    stopPingTimer: () => {},
  };
  return {
    state: stub as unknown as ServerState,
    streamManager,
  };
}

// ── Fake viewer socket — captures sendText / sendBinary calls in order ─────────

interface SentFrame {
  kind: "text" | "binary";
  payload: string;
}

function makeFakeViewer(
  sessionId: string,
  mode: "stream" | "interact" = "stream",
): { ws: ServerWebSocket<WsData>; frames: SentFrame[]; closes: Array<{ code: number; reason: string }> } {
  const frames: SentFrame[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const ws = {
    data: { sessionId, mode },
    sendText: (text: string) => {
      frames.push({ kind: "text", payload: text });
    },
    sendBinary: (data: Uint8Array) => {
      frames.push({ kind: "binary", payload: new TextDecoder().decode(data) });
    },
    getBufferedAmount: () => 0,
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
    },
    ping: () => {},
  } as unknown as ServerWebSocket<WsData>;
  return { ws, frames, closes };
}

// ── Source stubs ──────────────────────────────────────────────────────────────

/** Minimal PtySource reporting a fixed geometry (for the attach-frame test). */
class FixedGeomPty implements PtySource {
  constructor(private readonly geom: { cols: number; rows: number }) {}
  onData(): () => void {
    return () => {};
  }
  getScrollback(): string[] {
    return [];
  }
  write(): void {}
  resize(): void {}
  geometry(): { cols: number; rows: number } {
    return { ...this.geom };
  }
  close(): void {}
}

/** Like FixedGeomPty but with seeded scrollback (drives a binary frame). */
class ScrollbackGeomPty implements PtySource {
  constructor(
    private readonly geom: { cols: number; rows: number },
    private readonly lines: string[],
  ) {}
  onData(): () => void {
    return () => {};
  }
  getScrollback(): string[] {
    return [...this.lines];
  }
  write(): void {}
  resize(): void {}
  geometry(): { cols: number; rows: number } {
    return { ...this.geom };
  }
  close(): void {}
}

/**
 * tmux-like spy source: records restore calls so the auto-restore teardown can
 * be observed. Implements `onGeometryChange` so StreamManager treats it as a
 * geometry-capable (tmux) source, and `restoreGeometry` / `restoreWindowSize`
 * so server-websocket's `maybeRestoreTakeover` recognises it and invokes them.
 */
class TmuxSpyPty implements PtySource {
  restoreGeometryCalls: Array<{ cols: number; rows: number }> = [];
  restoreWindowSizeCalls = 0;
  private geom: { cols: number; rows: number };
  constructor(geom: { cols: number; rows: number } = { cols: 80, rows: 24 }) {
    this.geom = { ...geom };
  }
  onData(): () => void {
    return () => {};
  }
  getScrollback(): string[] {
    return [];
  }
  write(): void {}
  resize(cols: number, rows: number): void {
    this.geom = { cols, rows };
  }
  geometry(): { cols: number; rows: number } {
    return { ...this.geom };
  }
  onGeometryChange(): () => void {
    return () => {};
  }
  restoreGeometry(cols: number, rows: number): void {
    this.restoreGeometryCalls.push({ cols, rows });
  }
  restoreWindowSize(): void {
    this.restoreWindowSizeCalls += 1;
  }
  close(): void {}
}

// ── 3.1: geometry control frame at attach ─────────────────────────────────────

describe("geometry control frame at viewer attach (task 3.1)", () => {
  test("addViewer emits {type:'geometry',cols,rows} TEXT frame carrying pane geometry", () => {
    const sm = new StreamManager();
    const sid = "geom-attach-1";
    // A tmux-backed pane reports a non-default size; the viewer must learn it.
    sm.attach(sid, new FixedGeomPty({ cols: 137, rows: 42 }));

    const { ws, frames } = makeFakeViewer(sid);
    sm.addViewer(ws);

    // The FIRST frame to the viewer is the geometry control frame (TEXT), so the
    // emulator sizes its grid before scrollback bytes arrive.
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = frames[0]!;
    expect(first.kind).toBe("text");
    const parsed = JSON.parse(first.payload) as {
      type: string;
      cols: number;
      rows: number;
    };
    expect(parsed).toEqual({ type: "geometry", cols: 137, rows: 42 });

    sm.endSession(sid);
  });

  test("geometry frame is the first frame; precedes any binary scrollback frame", () => {
    const sm = new StreamManager();
    const sid = "geom-attach-2";
    // ScrollbackGeomPty seeds a scrollback line so addViewer also sends a binary
    // frame; the geometry TEXT frame must still come FIRST so the emulator sizes
    // its grid before cursor-positioning escapes in scrollback arrive.
    sm.attach(sid, new ScrollbackGeomPty({ cols: 100, rows: 30 }, ["hello world"]));

    const { ws, frames } = makeFakeViewer(sid);
    sm.addViewer(ws);

    const geomIdx = frames.findIndex(
      (f) => f.kind === "text" && f.payload.includes('"type":"geometry"'),
    );
    expect(geomIdx).toBe(0);
    const firstBinaryIdx = frames.findIndex((f) => f.kind === "binary");
    // Scrollback was seeded, so a binary frame must exist and come AFTER geometry.
    expect(firstBinaryIdx).toBeGreaterThan(-1);
    expect(geomIdx).toBeLessThan(firstBinaryIdx);

    sm.endSession(sid);
  });
});

// ── 3.3: take-over auto-restore on last-viewer disconnect ─────────────────────

describe("take-over auto-restore on last viewer disconnect (task 3.3)", () => {
  afterEach(() => {
    __resetTakeoverRegistry();
  });

  test("last take-over viewer disconnect restores original pane geometry", () => {
    const { state, streamManager } = makeStubState();
    try {
      const handlers = createWsHandlers(state);
      const sid = "restore-1";
      const pty = new TmuxSpyPty({ cols: 90, rows: 28 });
      streamManager.attach(sid, pty);

      // Simulate a take-over: a viewer attaches, then POST /commands/resize
      // records the ORIGINAL geometry and resizes the pane. We replicate that
      // server-side state directly: record original 90x28, then resize to a
      // bigger grid.
      const { ws } = makeFakeViewer(sid);
      state.allSockets.add(ws);
      streamManager.addViewer(ws);
      const created = recordOriginalGeometry(sid, 90, 28);
      expect(created).toBe(true);
      pty.resize(220, 64);
      expect(hasTakeover(sid)).toBe(true);

      // Last viewer disconnects → teardown must restore the recorded original.
      handlers.close(ws);

      expect(pty.restoreGeometryCalls).toEqual([{ cols: 90, rows: 28 }]);
      expect(pty.restoreWindowSizeCalls).toBe(1);
      // Record cleared after restore so a subsequent take-over re-captures clean.
      expect(hasTakeover(sid)).toBe(false);
    } finally {
      streamManager.shutdown();
    }
  });

  test("never-resized viewer disconnect does NOT resize the pane", () => {
    const { state, streamManager } = makeStubState();
    try {
      const handlers = createWsHandlers(state);
      const sid = "restore-2";
      const pty = new TmuxSpyPty({ cols: 80, rows: 24 });
      streamManager.attach(sid, pty);

      // A plain read-only (lock-mode) viewer: attaches, never triggers a resize,
      // so NO take-over record exists.
      const { ws } = makeFakeViewer(sid);
      state.allSockets.add(ws);
      streamManager.addViewer(ws);
      expect(hasTakeover(sid)).toBe(false);

      // Last viewer disconnects → no take-over record → must NOT touch tmux.
      handlers.close(ws);

      expect(pty.restoreGeometryCalls.length).toBe(0);
      expect(pty.restoreWindowSizeCalls).toBe(0);
    } finally {
      streamManager.shutdown();
    }
  });

  test("non-last viewer disconnect does NOT restore (only the last triggers)", () => {
    const { state, streamManager } = makeStubState();
    try {
      const handlers = createWsHandlers(state);
      const sid = "restore-3";
      const pty = new TmuxSpyPty({ cols: 100, rows: 30 });
      streamManager.attach(sid, pty);

      const a = makeFakeViewer(sid);
      const b = makeFakeViewer(sid);
      state.allSockets.add(a.ws);
      state.allSockets.add(b.ws);
      streamManager.addViewer(a.ws);
      streamManager.addViewer(b.ws);
      recordOriginalGeometry(sid, 100, 30);
      pty.resize(200, 50);

      // First viewer leaves — one viewer remains, so NO restore yet.
      handlers.close(a.ws);
      expect(pty.restoreGeometryCalls.length).toBe(0);
      expect(hasTakeover(sid)).toBe(true);

      // Last viewer leaves — now restore fires.
      handlers.close(b.ws);
      expect(pty.restoreGeometryCalls).toEqual([{ cols: 100, rows: 30 }]);
      expect(hasTakeover(sid)).toBe(false);
    } finally {
      streamManager.shutdown();
    }
  });
});
