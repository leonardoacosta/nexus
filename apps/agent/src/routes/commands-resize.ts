/**
 * POST /commands/resize — viewer-driven take-over resize of a session's PTY.
 *
 * Spec: pty-adaptive-geometry-fullscreen (nx-3bai2, task 1.5).
 *
 * Mirrors `commands/send-text` shape. A managed-gated viewer in "take-over"
 * mode forwards its own grid size; the agent resizes the underlying tmux pane
 * so the viewer can use its full window. The pane is auto-restored to its
 * pre-take-over geometry on viewer disconnect (server-websocket teardown).
 *
 * Request shape:
 *   POST /commands/resize
 *   { sessionId: string, cols: number, rows: number }
 *
 * Gating (authoritative, server-side — the client also hides the toggle for
 * non-managed sessions, but the server is the source of truth):
 *   - sessionType MUST be "managed" → else 409 (take-over not permitted).
 *   - cols/rows MUST be positive integers in range → else 400.
 *
 * On the FIRST resize for a session, the agent records the original pane
 * geometry in the take-over registry (read from PtySource.geometry()) BEFORE
 * applying, so auto-restore can revert it.
 *
 * On success returns 200 { ok: true }. On failure returns 4xx/5xx
 * with `{ error: string }`.
 */
import { createLogger } from "@nexus/core/node";
import type { SessionManager } from "../session-manager";
import type { StreamManager } from "../terminal/stream-manager";
import { markTakeover } from "../terminal/takeover-registry";

// Bounds match the interactive-resize validation in server-websocket.ts so the
// two resize paths agree on what a valid grid is.
const MIN_COLS = 1;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 300;

// Module-level handles, initialised from index.ts via initResizeRoute(...) so
// the route does not need a constructor. Lazy-checked at request time.
let _sessionManager: SessionManager | null = null;
let _streamManager: StreamManager | null = null;

export function initResizeRoute(
  sessionManager: SessionManager,
  streamManager: StreamManager,
): void {
  _sessionManager = sessionManager;
  _streamManager = streamManager;
}

export function resetResizeRoute(): void {
  _sessionManager = null;
  _streamManager = null;
}

const log = createLogger("agent:routes:commands-resize");

interface ResizeBody {
  sessionId: string;
  cols: number;
  rows: number;
}

function isResizeBody(value: unknown): value is ResizeBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.cols === "number" &&
    typeof v.rows === "number"
  );
}

function validDim(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export async function handleResize(request: Request): Promise<Response> {
  const sessionManager = _sessionManager;
  const streamManager = _streamManager;
  if (!sessionManager || !streamManager) {
    return jsonError(503, "resize route not initialised");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  if (!isResizeBody(raw)) {
    return jsonError(
      400,
      "expected { sessionId: string, cols: number, rows: number }",
    );
  }

  const { sessionId, cols, rows } = raw;

  // Validate dimensions BEFORE any session/gating work — cheap rejection.
  if (!validDim(cols, MIN_COLS, MAX_COLS) || !validDim(rows, MIN_ROWS, MAX_ROWS)) {
    return jsonError(
      400,
      `cols/rows out of range (cols ${MIN_COLS}-${MAX_COLS}, rows ${MIN_ROWS}-${MAX_ROWS})`,
    );
  }

  const session = sessionManager.getById(sessionId);
  if (!session) {
    return jsonError(404, `session not found: ${sessionId}`);
  }

  // Authoritative managed gate. Take-over mutates tmux state shared with the
  // real user, so it is only safe for sessions Nexus itself manages.
  if (session.sessionType !== "managed") {
    return jsonError(
      409,
      `take-over resize requires a managed session (got sessionType="${session.sessionType}")`,
    );
  }

  const pty = streamManager.getPty(sessionId);
  if (!pty) {
    return jsonError(409, `no active PTY for session: ${sessionId}`);
  }

  // Mark take-over active on the FIRST resize for this session (idempotent).
  // The flag drives the WS teardown path: on last-viewer disconnect it unsets
  // the tmux window-size option so tmux re-fits to the attached client.
  const firstResize = markTakeover(sessionId);

  // Apply the take-over resize.
  pty.resize(cols, rows);

  log.info(
    { sessionId, cols, rows, firstResize },
    "take-over resize applied",
  );

  return new Response(
    JSON.stringify({ ok: true, sessionId, cols, rows }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonError(status: number, error: string): Response {
  return new Response(
    JSON.stringify({ error }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
