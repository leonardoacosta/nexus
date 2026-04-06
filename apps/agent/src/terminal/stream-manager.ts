import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core";
import type { PtySource } from "./pty-source";

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
  /** Rolling buffer of recent output for reconnect replay. */
  lastOutput: ReconnectBuffer;
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

    this.sessions.set(sessionId, {
      pty,
      viewers,
      interactiveWriter: null,
      unsubscribe,
      lastOutput,
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
   * Try to claim interactive writer for a session.
   * Returns true if acquired, false if already held by another socket.
   */
  claimWriter(ws: ServerWebSocket<WsData>): boolean {
    const { sessionId } = ws.data;
    const stream = this.sessions.get(sessionId);
    if (!stream) return false;

    if (stream.interactiveWriter !== null && stream.interactiveWriter !== ws) {
      return false;
    }

    stream.interactiveWriter = ws;
    logger.debug({ sessionId }, "stream-manager: writer claimed");
    return true;
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
