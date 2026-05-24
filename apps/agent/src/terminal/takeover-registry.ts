/**
 * Take-over registry — per-session record of viewer-driven PTY resize state.
 *
 * Spec: pty-adaptive-geometry-fullscreen (nx-3bai2).
 *
 * Two call sites need this state but do not share a closure:
 *   - `POST /commands/resize` (routes/commands-resize.ts) records the ORIGINAL
 *     pane geometry on the first resize for a session, before mutating tmux.
 *   - The WS teardown path (server-websocket.ts removeViewer / pong-timeout)
 *     restores the recorded geometry when the LAST viewer disconnects, then
 *     clears the record.
 *
 * Keyed by sessionId. In-memory only — take-over is a transient,
 * single-process concern (the agent owns the tmux pane locally).
 *
 * Invariant: a record exists for a session IFF take-over has resized that
 * session at least once and it has not yet been restored. A session that was
 * never resized has NO record, so its viewers disconnecting must not resize
 * (the "never-resized disconnect must not resize" requirement, task 1.6).
 */

export interface TakeoverRecord {
  /** Pane geometry observed BEFORE the first take-over resize. */
  originalCols: number;
  originalRows: number;
}

const records = new Map<string, TakeoverRecord>();

/**
 * Record the original geometry for a session if not already recorded.
 * Idempotent: subsequent resizes for the same session do NOT overwrite the
 * first-captured original (so restore always reverts to pre-take-over state).
 * Returns true if this call created the record (i.e. it was the first resize).
 */
export function recordOriginalGeometry(
  sessionId: string,
  cols: number,
  rows: number,
): boolean {
  if (records.has(sessionId)) return false;
  records.set(sessionId, { originalCols: cols, originalRows: rows });
  return true;
}

/** Return the take-over record for a session, or undefined if never resized. */
export function getTakeoverRecord(sessionId: string): TakeoverRecord | undefined {
  return records.get(sessionId);
}

/** True if the session currently has an active take-over record. */
export function hasTakeover(sessionId: string): boolean {
  return records.has(sessionId);
}

/** Clear the take-over record for a session (after restore). */
export function clearTakeover(sessionId: string): void {
  records.delete(sessionId);
}

/** Test-only: wipe all records. */
export function __resetTakeoverRegistry(): void {
  records.clear();
}
