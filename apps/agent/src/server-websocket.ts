/**
 * WebSocket lifecycle management extracted from server.ts.
 *
 * Encapsulates:
 * - ServerState class (connection tracking, ping/pong heartbeat)
 * - WebSocket upgrade routing (stream, interact)
 * - WebSocket event handlers (open, message, close, pong)
 * - Connection limit enforcement
 *
 * Auth note: the legacy `x-nexus-secret` header / `?token=` query-string gate
 * was removed by `drop-attach-secret-gate`. Reachability is now bounded at
 * the bind layer (loopback + Tailscale only) — every connection that reaches
 * upgrade is already authenticated by WireGuard or local OS identity.
 *
 * Federation note: `/ws/federation` and the peer-connector were removed by
 * `remove-peer-connector` (spine-migration). The agent is no longer
 * peer-to-peer at the lifecycle-event layer; cross-machine awareness now
 * comes from clients reading `agents.toml` and querying each agent directly.
 */

import type { ServerWebSocket } from "bun";
import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import { HealthCollector } from "./health-collector";
import { StreamManager, type WsData } from "./terminal/stream-manager";
import { getSessionById } from "./db/sessions";
import { TmuxPtySource, isValidTmuxTarget } from "./terminal/tmux-pty-source";
import { hasTakeover, clearTakeover } from "./terminal/takeover-registry";

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
  readonly pongDeadlines = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();
  pingTimer: ReturnType<typeof setInterval> | null = null;

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
            // Restore take-over geometry BEFORE endSession closes the PTY.
            maybeRestoreTakeover(this, ws.data.sessionId);
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
 * Release the take-over when the LAST viewer of a session disconnects (normal
 * close OR pong timeout). UNSETS the tmux `window-size` option so tmux re-fits
 * the window to whatever client is attached, then clears the take-over record
 * (nx-cjhfv — replaces the previous "restore recorded geometry" behavior).
 *
 * No-op when:
 *   - other viewers remain (only the LAST disconnect releases), or
 *   - the session was never resized (no take-over record) — a plain read-only
 *     (lock-mode) viewer disconnecting MUST NOT touch the pane.
 *
 * pty-adaptive-geometry-fullscreen task 1.6.
 */
function maybeRestoreTakeover(state: ServerState, sessionId: string): void {
  // Only the last viewer triggers release.
  if (state.streamManager.viewerCount(sessionId) !== 0) return;
  // The take-over record is the "did take-over happen" flag. Absent => the
  // session was never resized, so leave tmux untouched.
  if (!hasTakeover(sessionId)) return;
  const pty = state.streamManager.getPty(sessionId);
  if (pty && typeof (pty as { unsetWindowSize?: unknown }).unsetWindowSize === "function") {
    const tmuxPty = pty as TmuxPtySource;
    try {
      // Unset window-size so tmux re-fits to the attached client(s).
      tmuxPty.unsetWindowSize();
    } catch (err) {
      logger.warn(
        { sessionId, error: err instanceof Error ? err.message : String(err) },
        "take-over release threw — clearing record anyway",
      );
    }
  }
  clearTakeover(sessionId);
  logger.debug(
    { sessionId },
    "take-over window-size unset on last viewer disconnect",
  );
}

/**
 * Try to lazy-attach a tmux-backed PtySource for a session row discovered by
 * the process-watcher. Returns true when a PTY is now registered against the
 * given sessionId (either pre-existing or freshly attached), false otherwise.
 *
 * The process-watcher inserts session rows with `tmux_session` and
 * `tmux_target` populated but never calls `streamManager.attach(...)`. Without
 * this lazy path, every WS upgrade for a discovered session returns 404 —
 * the bug tracked as `nx-omso0`. We resolve the tmux target on-demand the
 * first time a viewer connects and register a TmuxPtySource so subsequent
 * viewers (and reconnects) skip straight to the fast path.
 */
async function ensurePtyForSession(
  state: ServerState,
  sessionId: string,
  db: Db | undefined,
): Promise<boolean> {
  if (state.streamManager.getPty(sessionId)) return true;
  if (!db) return false;
  let row: Awaited<ReturnType<typeof getSessionById>> = null;
  try {
    row = await getSessionById(db, sessionId);
  } catch (err) {
    logger.warn(
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      "lazy-attach: getSessionById threw",
    );
    return false;
  }
  if (!row) return false;
  const target = row.tmuxTarget;
  if (!target || target.trim() === "") return false;
  if (!isValidTmuxTarget(target)) {
    logger.warn({ sessionId, tmuxTarget: target }, "lazy-attach: rejected unsafe tmux target");
    return false;
  }
  // Re-check under the implicit "no concurrent attach" assumption — if a
  // sibling viewer raced to attach() between our getPty() and DB read,
  // streamManager.attach() is a no-op (it returns early when the sessionId
  // is already present). The cost is one wasted TmuxPtySource construction
  // in the race window, which is bounded by a single tmux capture-pane.
  if (state.streamManager.getPty(sessionId)) return true;
  try {
    const pty = new TmuxPtySource(target);
    state.streamManager.attach(sessionId, pty);
    logger.info({ sessionId, tmuxTarget: target }, "lazy-attached tmux PtySource");
    return true;
  } catch (err) {
    logger.warn(
      { sessionId, tmuxTarget: target, error: err instanceof Error ? err.message : String(err) },
      "lazy-attach: TmuxPtySource construction threw",
    );
    return false;
  }
}

/**
 * Handle WebSocket upgrade requests for /sessions/:id/stream and
 * /sessions/:id/interact.
 *
 * Returns a Response on auth failure, connection limit, or bad request.
 * Returns `undefined` when the upgrade succeeds (Bun convention).
 * Returns `null` when the URL does not match any WebSocket route (caller
 * should continue to HTTP dispatch).
 *
 * When `db` is provided AND no PTY is registered for the session yet, the
 * handler will look the session up in the `sessions` table and lazy-attach
 * a `TmuxPtySource` if the row has a populated `tmux_target`. This is the
 * fix for nx-omso0 — without it every viewer click on a process-watcher-
 * discovered session hits 404.
 */
export function handleWsUpgrade(
  state: ServerState,
  request: Request,
  url: URL,
  server: import("bun").Server<WsData>,
  db?: Db,
): Response | Promise<Response | undefined> | undefined | null {
  // ── /sessions/:id/stream ────────────────────────────────────────────────
  const streamMatch = url.pathname.match(WS_STREAM_RE);
  if (streamMatch) {
    const sessionId = streamMatch[1]!;
    if (!SESSION_ID_RE.test(sessionId)) {
      return new Response("Bad Request", { status: 400 });
    }
    if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too Many Requests", { status: 429 });
    }
    return finalizeWsUpgrade(state, request, server, db, sessionId, "stream");
  }

  // ── /sessions/:id/interact ──────────────────────────────────────────────
  const interactMatch = url.pathname.match(WS_INTERACT_RE);
  if (interactMatch) {
    const sessionId = interactMatch[1]!;
    if (!SESSION_ID_RE.test(sessionId)) {
      return new Response("Bad Request", { status: 400 });
    }
    if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too Many Requests", { status: 429 });
    }
    return finalizeWsUpgrade(state, request, server, db, sessionId, "interact");
  }

  // URL did not match any WebSocket route
  return null;
}

/**
 * Shared finalisation path for both stream and interact upgrades. Returns a
 * Promise when a DB lookup is required to lazy-attach a tmux PtySource;
 * otherwise returns the synchronous Response/undefined the caller expects.
 *
 * NOTE: `server.upgrade(req, opts)` MUST be invoked while the original
 * `Request` is still in scope. Bun's fetch handler supports returning a
 * `Promise<Response | undefined>`, so awaiting a DB lookup here is safe.
 */
function finalizeWsUpgrade(
  state: ServerState,
  request: Request,
  server: import("bun").Server<WsData>,
  db: Db | undefined,
  sessionId: string,
  mode: "stream" | "interact",
): Response | Promise<Response | undefined> | undefined {
  // Fast path: PTY already attached.
  if (state.streamManager.getPty(sessionId)) {
    return performUpgrade(server, request, sessionId, mode);
  }
  // No PTY yet — attempt lazy attach if db is available, otherwise 404.
  if (!db) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return (async (): Promise<Response | undefined> => {
    const ok = await ensurePtyForSession(state, sessionId, db);
    if (!ok) {
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return performUpgrade(server, request, sessionId, mode);
  })();
}

function performUpgrade(
  server: import("bun").Server<WsData>,
  request: Request,
  sessionId: string,
  mode: "stream" | "interact",
): Response | undefined {
  const upgraded = server.upgrade(request, { data: { sessionId, mode } });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  return undefined;
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

      if (ws.data.mode === "interact") {
        // Claim the writer mutex — SYMMETRIC last-open-wins. The new opener
        // WINS: any prior holder is evicted (closed 4009) inside claimWriter.
        // claimWriter returns false ONLY when no stream is registered for the
        // session, so the new opener is closed 4009 only in that case — never
        // for writer contention (that's the prior holder's eviction now).
        const claimed = state.streamManager.claimWriter(ws);
        // NXPTY-DIAG (mx-rkir.13): surface interact-open + writer-claim outcome
        // so we can see whether an iOS interact WS actually opens + holds the
        // writer mutex (vs a silent 4009 denial dropping all keystrokes).
        logger.info(
          { sessionId: ws.data.sessionId, claimed },
          "NXPTY interact open: writer-claim result",
        );
        if (!claimed) {
          // Only reachable when the session has no registered stream.
          ws.close(4009, "interactive session not available");
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

      // NXPTY-DIAG (mx-rkir.13): every frame on the interact socket — byte
      // count, frame kind, and whether THIS socket holds the writer mutex.
      // This is the definitive "did the iOS keystroke frame ARRIVE at the
      // agent" signal; pair it with the iOS NXPTY send log.
      if (mode === "interact") {
        const byteLen = typeof msg === "string" ? Buffer.byteLength(msg) : msg.length;
        logger.info(
          {
            sessionId,
            bytes: byteLen,
            kind: typeof msg === "string" ? "text" : "binary",
            isWriter: state.streamManager.isWriter(ws),
          },
          "NXPTY interact frame RECEIVED",
        );
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
        // NXPTY-DIAG (mx-rkir.13): confirm the binary keystroke bytes reach
        // pty.write() (and thus tmux send-keys). `hasPty=false` would mean the
        // frame arrived but no PTY is attached for the session.
        logger.info(
          { sessionId, bytes: data.length, hasPty: true },
          "NXPTY interact binary -> pty.write()",
        );
        pty.write(data);
      } else {
        logger.info(
          { sessionId, bytes: msg.length, hasPty: false },
          "NXPTY interact binary DROPPED — no PTY attached",
        );
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      state.allSockets.delete(ws);
      const deadline = state.pongDeadlines.get(ws);
      if (deadline) {
        clearTimeout(deadline);
        state.pongDeadlines.delete(ws);
      }

      // nx-y4hjl: capture the reclaim flag BEFORE removeViewer. When this
      // socket is being evicted by a live writer reclaim (last-open-wins), the
      // new writer is about to register as a viewer — so even if removing this
      // socket drops viewerCount to 0 momentarily, we MUST NOT tear the PTY
      // down. Skipping endSession here keeps the session alive for the inheritor.
      const reclaiming = state.streamManager.isReclaiming(ws);

      state.streamManager.removeViewer(ws);
      // Mirror the pong-timeout path: tear down the PTY session when the
      // last viewer disconnects normally (task 1.1 — PTY orphan fix). A reclaim
      // handoff is exempt — the session survives for the new writer.
      if (!reclaiming && state.streamManager.viewerCount(ws.data.sessionId) === 0) {
        // Restore take-over geometry BEFORE endSession closes the PTY
        // (pty-adaptive-geometry-fullscreen task 1.6).
        maybeRestoreTakeover(state, ws.data.sessionId);
        state.streamManager.endSession(ws.data.sessionId);
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
