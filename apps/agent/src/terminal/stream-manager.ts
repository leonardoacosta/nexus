import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core/node";
import type { PtySource } from "./pty-source";
import { getTakeoverGeometry } from "./takeover-registry";

export interface WsData {
  sessionId: string;
  mode: "stream" | "interact";
}

/** Capacity of the per-session reconnect ring buffer (number of output chunks). */
const RECONNECT_BUFFER_CAPACITY = 1000;

/** Simple ring buffer for raw Uint8Array chunks. */
class ReconnectBuffer {
  private buf: Uint8Array[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buf = new Array<Uint8Array>(capacity);
  }

  push(chunk: Uint8Array): void {
    this.buf[this.head] = chunk;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): Uint8Array[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buf.slice(0, this.count);
    }
    // Wrap-around: oldest is at `head`
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }
}

interface SessionStream {
  pty: PtySource;
  viewers: Set<ServerWebSocket<WsData>>;
  interactiveWriter: ServerWebSocket<WsData> | null;
  unsubscribe: () => void;
  /** Unsubscribe from source geometry-change notifications (tmux sources). */
  unsubscribeGeometry: () => void;
  /** Rolling buffer of recent output for reconnect replay. */
  lastOutput: ReconnectBuffer;
  /**
   * Set of sockets being EVICTED by an in-flight writer reclaim (last-open-wins).
   *
   * nx-y4hjl: `claimWriter` evicts the prior holder via `prior.close(4009)`,
   * which fires the prior socket's Bun close handler SYNCHRONOUSLY. If the prior
   * holder was the only other viewer, that close handler would observe
   * viewerCount === 0 and tear the PTY down — destroying the session the new
   * writer is about to inherit. We mark the evicted socket here for the duration
   * of the synchronous close so the close handler can recognise a reclaim
   * handoff and SKIP the last-viewer teardown. The new writer registers as a
   * viewer immediately after, keeping the session alive.
   */
  reclaiming: Set<ServerWebSocket<WsData>>;
}

/** Serialize a geometry control frame (sent as a WS TEXT frame). */
function geometryFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: "geometry", cols, rows });
}

/**
 * Narrow a PtySource that also supports geometry-change subscription
 * (TmuxPtySource). node-pty / mock sources do not push geometry changes.
 */
function hasGeometryChange(
  pty: PtySource,
): pty is PtySource & {
  onGeometryChange(cb: (geom: { cols: number; rows: number }) => void): () => void;
} {
  return typeof (pty as { onGeometryChange?: unknown }).onGeometryChange === "function";
}

/**
 * Manages per-session fan-out of PTY output to WebSocket viewers,
 * and tracks the interactive writer mutex.
 */
export class StreamManager {
  private sessions = new Map<string, SessionStream>();

  /**
   * Register a PTY source for a session.  Must be called before any
   * WebSocket connections are accepted for that session.
   */
  attach(sessionId: string, pty: PtySource): void {
    if (this.sessions.has(sessionId)) return;

    const viewers = new Set<ServerWebSocket<WsData>>();
    const lastOutput = new ReconnectBuffer(RECONNECT_BUFFER_CAPACITY);

    const unsubscribe = pty.onData((data) => {
      // Record in reconnect buffer before forwarding
      lastOutput.push(data);

      for (const ws of viewers) {
        // Disconnect slow viewers whose send buffer exceeds 1 MB (task 1.5)
        if (ws.getBufferedAmount() > 1024 * 1024) {
          try {
            ws.close(1008, "send buffer overflow — viewer too slow");
          } catch {
            // ignore — will be cleaned up on close event
          }
          continue;
        }
        try {
          ws.sendBinary(data);
        } catch {
          // dead socket — will be cleaned up on close
        }
      }
    });

    // Subscribe to source-initiated geometry changes (a real user resizing the
    // tmux pane, or tmux reflow). On change, push a `geometry` TEXT control
    // frame to every viewer so lock-mode emulators re-size their grid and stay
    // aligned. Non-tmux sources (node-pty / mock) do not push changes.
    let unsubscribeGeometry: () => void = () => {};
    if (hasGeometryChange(pty)) {
      unsubscribeGeometry = pty.onGeometryChange((geom) => {
        const frame = geometryFrame(geom.cols, geom.rows);
        const stream = this.sessions.get(sessionId);
        if (!stream) return;
        for (const ws of stream.viewers) {
          try {
            ws.sendText(frame);
          } catch {
            // dead socket — cleaned up on close
          }
        }
      });
    }

    this.sessions.set(sessionId, {
      pty,
      viewers,
      interactiveWriter: null,
      unsubscribe,
      unsubscribeGeometry,
      lastOutput,
      reclaiming: new Set<ServerWebSocket<WsData>>(),
    });

    logger.debug({ sessionId }, "stream-manager: attached");
  }

  /** Get the PtySource for a session (if attached). */
  getPty(sessionId: string): PtySource | undefined {
    return this.sessions.get(sessionId)?.pty;
  }

  /**
   * Replay the reconnect buffer to a viewer WebSocket (task 3.2).
   * Sends all buffered output chunks followed by a `{ type: "replay_done" }` sentinel.
   * No-op if the session does not exist.
   */
  replayBuffer(ws: ServerWebSocket<WsData>): void {
    const stream = this.sessions.get(ws.data.sessionId);
    if (!stream) return;

    const chunks = stream.lastOutput.toArray();
    for (const chunk of chunks) {
      try {
        ws.sendBinary(chunk);
      } catch {
        // dead socket
        return;
      }
    }
    try {
      ws.sendText(JSON.stringify({ type: "replay_done" }));
    } catch {
      // ignore
    }
    logger.debug({ sessionId: ws.data.sessionId, chunks: chunks.length }, "stream-manager: replay done");
  }

  /** Add a viewer WebSocket. Sends scrollback on connect. */
  addViewer(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;
    const stream = this.sessions.get(sessionId);
    if (!stream) {
      ws.close(4004, "session not found");
      return;
    }

    stream.viewers.add(ws);

    // Re-apply a PENDING take-over resize that landed before this PTY attached.
    // The phone POSTs `/commands/resize` and opens `/sessions/:id/stream` near-
    // simultaneously; when the POST wins the race the resize route records the
    // geometry but cannot apply it (no PTY yet). On attach we re-fire it here so
    // the pane reflows to the phone width immediately — the core mx-rkir.12 fix.
    // No-op for ordinary lock-mode viewers (no take-over record).
    const pending = getTakeoverGeometry(sessionId);
    if (pending) {
      try {
        stream.pty.resize(pending.cols, pending.rows);
        logger.info(
          { sessionId, cols: pending.cols, rows: pending.rows },
          "take-over resize applied on stream attach (deferred-resize replay)",
        );
      } catch (err) {
        logger.warn(
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          "deferred take-over resize on attach threw",
        );
      }
    }

    // Send the geometry control frame FIRST (TEXT) so the viewer sizes its
    // emulator grid to the source's pane geometry BEFORE the scrollback bytes
    // (BINARY) arrive — cursor-positioning escapes in scrollback then land in
    // the right cells (fixes the jumble). pty-adaptive-geometry-fullscreen 1.4.
    try {
      const geom = stream.pty.geometry();
      ws.sendText(geometryFrame(geom.cols, geom.rows));
    } catch {
      // best-effort — a missing geometry frame degrades to the viewer's
      // default grid, not a crash.
    }

    // Send scrollback buffer — each line gets exactly one newline (task 7.1)
    const scrollback = stream.pty.getScrollback();
    if (scrollback.length > 0) {
      const joined = scrollback.map((l) => l + "\n").join("");
      ws.sendBinary(new TextEncoder().encode(joined));
    }

    logger.debug({ sessionId, viewerCount: stream.viewers.size }, "stream-manager: viewer added");
  }

  /** Remove a viewer WebSocket. */
  removeViewer(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;
    const stream = this.sessions.get(sessionId);
    if (!stream) return;

    stream.viewers.delete(ws);

    // If this was the interactive writer, release the mutex
    if (stream.interactiveWriter === ws) {
      stream.interactiveWriter = null;
      // Notify remaining viewers that interactive control was released
      const msg = JSON.stringify({ type: "writer_disconnected" });
      for (const v of stream.viewers) {
        try {
          v.sendText(msg);
        } catch {
          // ignore
        }
      }
      logger.debug({ sessionId }, "stream-manager: interactive writer released");
    }

    logger.debug({ sessionId, viewerCount: stream.viewers.size }, "stream-manager: viewer removed");
  }

  /**
   * Claim interactive writer for a session — SYMMETRIC last-open-wins.
   *
   * The newest client to open the interact channel WINS the writer mutex; any
   * prior holder is EVICTED (not the new opener refused). Eviction closes the
   * prior socket with code 4009 — the macOS (PtyInteractChannel.markReadOnly)
   * and web (agent-ws-client.ts keys off 4009) clients already flip to
   * read-only on that close, so no new control frame is needed.
   *
   * Returns true when the writer is acquired (always, when the session exists),
   * false ONLY when the session has no registered stream (can't claim an
   * unregistered stream).
   */
  claimWriter(ws: ServerWebSocket<WsData>): boolean {
    const { sessionId } = ws.data;
    const stream = this.sessions.get(sessionId);
    if (!stream) return false;

    const prior = stream.interactiveWriter;
    if (prior !== null && prior !== ws) {
      // Evict the prior holder — last open wins. Reuse the existing 4009 close
      // (same code the writer-mutex denial used) so existing clients keep their
      // read-only fallback with no protocol change.
      //
      // nx-y4hjl: `prior.close()` fires the prior socket's Bun close handler
      // SYNCHRONOUSLY (confirmed: endSession was observed firing between this
      // claim and the new writer's addViewer). Mark `prior` as reclaiming for
      // the duration of that synchronous close so the close handler skips its
      // last-viewer PTY teardown — the new writer is about to register as a
      // viewer and inherit the live session. `finally` guarantees the flag is
      // cleared even if a real close path also removes the entry.
      stream.reclaiming.add(prior);
      try {
        prior.close(4009, "interactive writer reclaimed by another client");
      } catch {
        // dead socket — close handler / cleanup will reconcile state
      } finally {
        stream.reclaiming.delete(prior);
      }
      logger.debug({ sessionId }, "stream-manager: prior interactive writer evicted (last-open-wins)");
    }

    stream.interactiveWriter = ws;
    logger.debug({ sessionId }, "stream-manager: writer claimed");
    return true;
  }

  /**
   * True when `ws` is currently being evicted by an in-flight writer reclaim
   * (last-open-wins handoff). The close handler consults this to suppress the
   * last-viewer PTY teardown so a reclaim does NOT destroy the session the new
   * writer is inheriting (nx-y4hjl).
   */
  isReclaiming(ws: ServerWebSocket<WsData>): boolean {
    return this.sessions.get(ws.data.sessionId)?.reclaiming.has(ws) ?? false;
  }

  /** Check if a given socket is the current interactive writer. */
  isWriter(ws: ServerWebSocket<WsData>): boolean {
    const stream = this.sessions.get(ws.data.sessionId);
    return stream?.interactiveWriter === ws;
  }

  /**
   * End a session — notify all viewers and close connections.
   */
  endSession(sessionId: string): void {
    const stream = this.sessions.get(sessionId);
    if (!stream) return;

    const msg = JSON.stringify({ type: "session_ended" });
    for (const ws of stream.viewers) {
      try {
        ws.sendText(msg);
        ws.close(1000, "session ended");
      } catch {
        // ignore
      }
    }

    stream.unsubscribe();
    stream.unsubscribeGeometry();
    stream.pty.close();
    stream.viewers.clear();
    stream.interactiveWriter = null;
    this.sessions.delete(sessionId);

    logger.debug({ sessionId }, "stream-manager: session ended");
  }

  /** Return the number of active viewers for a session (0 if session not found). */
  viewerCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.viewers.size ?? 0;
  }

  /** Detach all sessions. */
  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.endSession(sessionId);
    }
  }
}
