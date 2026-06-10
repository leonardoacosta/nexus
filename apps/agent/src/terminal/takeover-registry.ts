/**
 * Take-over registry — per-session flag tracking whether viewer-driven resize
 * (take-over) is active for a session.
 *
 * Spec: pty-adaptive-geometry-fullscreen (nx-3bai2); release semantics revised
 * by nx-cjhfv (unset-and-refit instead of restore-recorded-geometry).
 *
 * Two call sites need this state but do not share a closure:
 *   - `POST /commands/resize` (routes/commands-resize.ts) marks take-over
 *     active on the first resize for a session, before mutating tmux.
 *   - The WS teardown path (server-websocket.ts removeViewer / pong-timeout)
 *     UNSETS the tmux `window-size` option when the LAST viewer disconnects,
 *     then clears the flag.
 *
 * Keyed by sessionId. In-memory only — take-over is a transient,
 * single-process concern (the agent owns the tmux pane locally).
 *
 * Invariant: the flag is set for a session IFF take-over has resized that
 * session at least once and it has not yet been released. A session that was
 * never resized is NOT flagged, so its viewers disconnecting must not touch the
 * pane (the "never-resized disconnect must not resize" requirement, task 1.6).
 *
 * No recorded geometry is kept: release unsets `window-size` and lets tmux
 * re-fit to the attached client, so the pre-take-over dims are irrelevant.
 */

export interface TakeoverGeometry {
  cols: number;
  rows: number;
}

/**
 * Per-session take-over state. Presence of an entry means take-over is active
 * (replaces the old boolean-Set flag). The stored geometry is the LAST resize
 * the viewer requested, retained so a later stream attach can RE-APPLY it: the
 * phone's resize POST can land before its `/sessions/:id/stream` WS has attached
 * the PtySource (the cause of mx-rkir.12 — POST 404/409s, tmux stays 317). By
 * recording the requested grid here, `addViewer` re-fires the take-over the
 * moment the PTY exists, so the pane reliably reflows to the phone width even
 * when the POST raced ahead of the attach.
 */
const records = new Map<string, TakeoverGeometry>();

/**
 * Record (or update) the take-over geometry for a session. Idempotent w.r.t.
 * "is take-over active" — returns true only the FIRST time a session is marked
 * (i.e. the first resize), matching the previous markTakeover() contract so the
 * resize route's `firstResize` log stays accurate.
 */
export function markTakeover(
  sessionId: string,
  geometry?: TakeoverGeometry,
): boolean {
  const first = !records.has(sessionId);
  // Always store the latest requested geometry (default to a sentinel if the
  // caller omits it — callers that have the dims always pass them).
  records.set(sessionId, geometry ?? records.get(sessionId) ?? { cols: 0, rows: 0 });
  return first;
}

/** True if the session currently has an active take-over. */
export function hasTakeover(sessionId: string): boolean {
  return records.has(sessionId);
}

/**
 * Pending take-over geometry for a session, if any. Returns undefined when no
 * take-over is active or the recorded geometry is the zero sentinel (never a
 * real resize). Used by the stream-attach path to re-apply a resize that
 * raced ahead of the PTY attach.
 */
export function getTakeoverGeometry(sessionId: string): TakeoverGeometry | undefined {
  const geom = records.get(sessionId);
  if (!geom || geom.cols < 1 || geom.rows < 1) return undefined;
  return { ...geom };
}

/** Clear the take-over record for a session (after release). */
export function clearTakeover(sessionId: string): void {
  records.delete(sessionId);
}

/** Test-only: wipe all records. */
export function __resetTakeoverRegistry(): void {
  records.clear();
}
