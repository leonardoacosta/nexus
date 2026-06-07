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

const flagged = new Set<string>();

/**
 * Mark take-over active for a session if not already marked. Idempotent.
 * Returns true if this call set the flag (i.e. it was the first resize).
 */
export function markTakeover(sessionId: string): boolean {
  if (flagged.has(sessionId)) return false;
  flagged.add(sessionId);
  return true;
}

/** True if the session currently has an active take-over. */
export function hasTakeover(sessionId: string): boolean {
  return flagged.has(sessionId);
}

/** Clear the take-over flag for a session (after release). */
export function clearTakeover(sessionId: string): void {
  flagged.delete(sessionId);
}

/** Test-only: wipe all flags. */
export function __resetTakeoverRegistry(): void {
  flagged.clear();
}
