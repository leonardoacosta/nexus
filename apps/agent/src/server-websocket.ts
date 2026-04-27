/**
 * WebSocket lifecycle management extracted from server.ts.
 *
 * Encapsulates:
 * - ServerState class (connection tracking, ping/pong heartbeat)
 * - WebSocket upgrade routing (stream, interact, federation)
 * - WebSocket event handlers (open, message, close, pong)
 * - Connection limit enforcement
 *
 * Auth note: the legacy `x-nexus-secret` header / `?token=` query-string gate
 * was removed by `drop-attach-secret-gate`. Reachability is now bounded at
 * the bind layer (loopback + Tailscale only) — every connection that reaches
 * upgrade is already authenticated by WireGuard or local OS identity.
 */

import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core/node";
import { HealthCollector } from "./health-collector";
import { StreamManager, type WsData } from "./terminal/stream-manager";
import {
  lifecycleBus,
  type LifecycleEnvelope,
} from "./services/lifecycle-bus";

// ── WebSocket keepalive constants ───────────────────────────────────────────
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ── Connection limit ────────────────────────────────────────────────────────
const MAX_CONCURRENT_CONNECTIONS = 50;

// ── Session ID validation ───────────────────────────────────────────────────
const SESSION_ID_RE = /^[a-zA-Z0-9_.-]+$/;

// ── WebSocket route patterns ────────────────────────────────────────────────
const WS_STREAM_RE = /^\/sessions\/([^/]+)\/stream$/;
const WS_INTERACT_RE = /^\/sessions\/([^/]+)\/interact$/;
const WS_FEDERATION_PATH = "/ws/federation";

// ── ServerState: encapsulates all per-server mutable state ─────────────────

/**
 * Encapsulates all mutable state owned by a single server instance.
 *
 * Each call to `ServerState.create()` produces an independent instance so that
 * test files that spin up their own server receive isolated state with no
 * cross-test bleed through shared module-level variables.
 */
export class ServerState {
  readonly healthCollector: HealthCollector;
  readonly streamManager: StreamManager;

  readonly allSockets = new Set<ServerWebSocket<WsData>>();
  readonly federationSockets = new Set<ServerWebSocket<WsData>>();
  readonly pongDeadlines = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();
  pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-federation-socket bus unsubscribe functions. */
  readonly federationCleanup = new Map<ServerWebSocket<WsData>, () => void>();

  private constructor(hc: HealthCollector, sm: StreamManager) {
    this.healthCollector = hc;
    this.streamManager = sm;
  }

  /** Create a fresh, isolated ServerState with its own HealthCollector and StreamManager. */
  static create(): ServerState {
    const hc = new HealthCollector();
    hc.start();
    const sm = new StreamManager();
    return new ServerState(hc, sm);
  }

  startPingTimer(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const ws of this.allSockets) {
        ws.ping();
        const timeout = setTimeout(() => {
          this.pongDeadlines.delete(ws);
          // Clean up viewer state before closing (task 1.6)
          this.streamManager.removeViewer(ws);
          if (this.streamManager.viewerCount(ws.data.sessionId) === 0) {
            this.streamManager.endSession(ws.data.sessionId);
          }
          try {
            ws.close(1001, "pong timeout");
          } catch {
            // already closed
          }
        }, PONG_TIMEOUT_MS);
        this.pongDeadlines.set(ws, timeout);
      }
    }, PING_INTERVAL_MS);
  }

  stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const t of this.pongDeadlines.values()) clearTimeout(t);
    this.pongDeadlines.clear();
  }
}

/**
 * Handle WebSocket upgrade requests for /sessions/:id/stream,
 * /sessions/:id/interact, and /ws/federation.
 *
 * Returns a Response on auth failure, connection limit, or bad request.
 * Returns `undefined` when the upgrade succeeds (Bun convention).
 * Returns `null` when the URL does not match any WebSocket route (caller
 * should continue to HTTP dispatch).
 */
export function handleWsUpgrade(
  state: ServerState,
  request: Request,
  url: URL,
  server: import("bun").Server<WsData>,
): Response | undefined | null {
  // ── /sessions/:id/stream ────────────────────────────────────────────────
  const streamMatch = url.pathname.match(WS_STREAM_RE);
  if (streamMatch) {
    const sessionId = streamMatch[1]!;
    // Validate session ID against safe pattern
    if (!SESSION_ID_RE.test(sessionId)) {
      return new Response("Bad Request", { status: 400 });
    }
    // Enforce connection limit
    if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too Many Requests", { status: 429 });
    }
    if (!state.streamManager.getPty(sessionId)) {
      // No PTY attached — session doesn't exist or isn't streamable
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const upgraded = server.upgrade(request, {
      data: { sessionId, mode: "stream" },
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  }

  // ── /sessions/:id/interact ──────────────────────────────────────────────
  const interactMatch = url.pathname.match(WS_INTERACT_RE);
  if (interactMatch) {
    const sessionId = interactMatch[1]!;
    // Validate session ID against safe pattern
    if (!SESSION_ID_RE.test(sessionId)) {
      return new Response("Bad Request", { status: 400 });
    }
    // Enforce connection limit
    if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too Many Requests", { status: 429 });
    }
    if (!state.streamManager.getPty(sessionId)) {
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const upgraded = server.upgrade(request, {
      data: { sessionId, mode: "interact" },
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  }

  // ── /ws/federation ──────────────────────────────────────────────────────
  if (url.pathname === WS_FEDERATION_PATH) {
    if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too Many Requests", { status: 429 });
    }
    const upgraded = server.upgrade(request, {
      data: { sessionId: "__federation__", mode: "federation" as const },
    });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return undefined;
  }

  // URL did not match any WebSocket route
  return null;
}

/**
 * Bun WebSocket handlers object, parameterised by ServerState.
 *
 * Usage: pass the return value as the `websocket` option to `Bun.serve()`.
 */
export function createWsHandlers(state: ServerState) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      state.allSockets.add(ws);
      state.startPingTimer();

      // ── Federation mode: subscribe to lifecycle bus ──────────────
      if (ws.data.mode === "federation") {
        state.federationSockets.add(ws);

        const handler = (envelope: LifecycleEnvelope) => {
          // Only forward local events to the peer (prevent echo)
          if (envelope.source === "peer") return;
          try {
            ws.sendText(JSON.stringify(envelope));
          } catch {
            // Socket may have closed — ignore
          }
        };

        lifecycleBus.onAny(handler);
        state.federationCleanup.set(ws, () => lifecycleBus.offAny(handler));

        logger.debug("ws: federation peer connected");
        return;
      }

      if (ws.data.mode === "interact") {
        // Try to claim the writer mutex
        const claimed = state.streamManager.claimWriter(ws);
        if (!claimed) {
          ws.close(4009, "interactive session already held by another client");
          state.allSockets.delete(ws);
          return;
        }
      }

      // Register as viewer (both stream and interact get output)
      state.streamManager.addViewer(ws);

      logger.debug({ sessionId: ws.data.sessionId, mode: ws.data.mode }, "ws: open");
    },

    message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
      const { sessionId, mode } = ws.data;

      // ── Federation: parse peer events and inject into bus ──────────
      if (mode === "federation") {
        if (typeof msg === "string") {
          try {
            const envelope = JSON.parse(msg) as LifecycleEnvelope;
            if (envelope.event && envelope.payload) {
              lifecycleBus.injectPeerEvent(envelope);
            }
          } catch {
            logger.debug("ws: federation received invalid JSON");
          }
        }
        return;
      }

      if (mode !== "interact") {
        // Stream-only clients may send a reconnect frame to replay buffered output.
        if (typeof msg === "string") {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.type === "reconnect" && typeof parsed.sessionId === "string") {
              state.streamManager.replayBuffer(ws);
            }
          } catch {
            // Not a valid JSON control frame — ignore
          }
        }
        return;
      }

      // Defense-in-depth: ensure this socket holds the writer mutex before
      // processing any input. Protects against race conditions where a socket
      // loses writer status between the open() claim and message receipt.
      if (!state.streamManager.isWriter(ws)) {
        ws.sendText(JSON.stringify({ type: "error", message: "not the interactive writer" }));
        return;
      }

      // JSON control frames (text)
      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
            // Task 1.7: Validate cols/rows ranges
            const cols = parsed.cols;
            const rows = parsed.rows;
            if (
              !Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1 || cols > 500 ||
              !Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1 || rows > 300
            ) {
              ws.sendText(JSON.stringify({ type: "error", message: "Invalid resize dimensions" }));
              return;
            }
            const pty = state.streamManager.getPty(sessionId);
            if (pty) {
              pty.resize(cols, rows);
            }
            return;
          }
        } catch {
          // Not JSON — treat as text input
        }
        // Write text as bytes
        const pty = state.streamManager.getPty(sessionId);
        if (pty) {
          pty.write(new TextEncoder().encode(msg));
        }
        return;
      }

      // Binary frame — raw stdin bytes
      const pty = state.streamManager.getPty(sessionId);
      if (pty) {
        const data = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
        pty.write(data);
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      state.allSockets.delete(ws);
      const deadline = state.pongDeadlines.get(ws);
      if (deadline) {
        clearTimeout(deadline);
        state.pongDeadlines.delete(ws);
      }

      // ── Federation cleanup ────────────────────────────────────────
      if (ws.data.mode === "federation") {
        state.federationSockets.delete(ws);
        const cleanup = state.federationCleanup.get(ws);
        if (cleanup) {
          cleanup();
          state.federationCleanup.delete(ws);
        }
        logger.debug("ws: federation peer disconnected");
      } else {
        state.streamManager.removeViewer(ws);
        // Mirror the pong-timeout path: tear down the PTY session when the
        // last viewer disconnects normally (task 1.1 — PTY orphan fix).
        if (state.streamManager.viewerCount(ws.data.sessionId) === 0) {
          state.streamManager.endSession(ws.data.sessionId);
        }
      }

      logger.debug({ sessionId: ws.data.sessionId, mode: ws.data.mode }, "ws: close");

      // Stop ping timer if no sockets remain
      if (state.allSockets.size === 0) {
        state.stopPingTimer();
      }
    },

    pong(ws: ServerWebSocket<WsData>) {
      // Clear the pong deadline — connection is still alive
      const deadline = state.pongDeadlines.get(ws);
      if (deadline) {
        clearTimeout(deadline);
        state.pongDeadlines.delete(ws);
      }
    },

    // No per-message compression — raw terminal bytes should flow with minimal overhead
    perMessageDeflate: false as const,
  };
}
