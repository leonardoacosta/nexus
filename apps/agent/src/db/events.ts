import type { Db } from "@nexus/db";
import { sessionEvents } from "@nexus/db";
import { eq, asc } from "drizzle-orm";

/** Row shape returned from the `session_events` table. */
export type SessionEventRow = typeof sessionEvents.$inferSelect;

/** Insert value shape (no `id` — it's auto-generated). */
type SessionEventInsert = typeof sessionEvents.$inferInsert;

/** Append a new event for a session. Returns the inserted row's id. */
export async function appendSessionEvent(
  db: Db,
  event: Omit<SessionEventInsert, "id">,
): Promise<number> {
  const [row] = await db
    .insert(sessionEvents)
    .values(event)
    .returning({ id: sessionEvents.id });
  if (!row) {
    throw new Error("appendSessionEvent: insert returned no rows");
  }
  return row.id;
}

/** Query all events for a given session, ordered by timestamp ascending. */
export async function querySessionEvents(
  db: Db,
  sessionId: string,
): Promise<SessionEventRow[]> {
  return db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.timestamp));
}
