import type { Database } from "bun:sqlite";

/** Row shape stored in the `session_events` table. */
export interface SessionEventRow {
  id?: number;
  session_id: string;
  event_type: string;
  timestamp: string;
  metadata: string | null;
}

/** Append a new event for a session. */
export function appendSessionEvent(
  db: Database,
  event: Omit<SessionEventRow, "id">,
): void {
  db.query(
    `INSERT INTO session_events (session_id, event_type, timestamp, metadata)
     VALUES ($session_id, $event_type, $timestamp, $metadata)`,
  ).run({
    $session_id: event.session_id,
    $event_type: event.event_type,
    $timestamp: event.timestamp,
    $metadata: event.metadata,
  });
}

/** Query all events for a given session, ordered by timestamp ascending. */
export function querySessionEvents(
  db: Database,
  sessionId: string,
): SessionEventRow[] {
  return db
    .query(
      `SELECT * FROM session_events WHERE session_id = $session_id ORDER BY timestamp ASC`,
    )
    .all({ $session_id: sessionId }) as SessionEventRow[];
}
