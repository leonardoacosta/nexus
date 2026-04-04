import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core";
import type { PtySource } from "./pty-source";

export interface WsData {
  sessionId: string;
  mode: "stream" | "interact";
}

interface SessionStream {
  pty: PtySource;
  viewers: Set<ServerWebSocket<WsData>>;
  interactiveWriter: ServerWebSocket<WsData> | null;
  unsubscribe: () => void;
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

    const unsubscribe = pty.onData((data) => {
      for (const ws of viewers) {
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
    });

    logger.debug("stream-manager: attached", { sessionId });
  }

  /** Get the PtySource for a session (if attached). */
  getPty(sessionId: string): PtySource | undefined {
    return this.sessions.get(sessionId)?.pty;
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

    // Send scrollback buffer
    const scrollback = stream.pty.getScrollback();
    if (scrollback.length > 0) {
      const joined = scrollback.join("\n") + "\n";
      ws.sendBinary(new TextEncoder().encode(joined));
    }

    logger.debug("stream-manager: viewer added", {
      sessionId,
      viewerCount: stream.viewers.size,
    });
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
      logger.debug("stream-manager: interactive writer released", { sessionId });
    }

    logger.debug("stream-manager: viewer removed", {
      sessionId,
      viewerCount: stream.viewers.size,
    });
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
    logger.debug("stream-manager: writer claimed", { sessionId });
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

    logger.debug("stream-manager: session ended", { sessionId });
  }

  /** Detach all sessions. */
  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.endSession(sessionId);
    }
  }
}
