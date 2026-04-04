import type { Db } from "@nexus/db";
import { sessionEvents } from "@nexus/db";
import { eq, asc } from "drizzle-orm";

/** Row shape returned from the `session_events` table. */
export type SessionEventRow = typeof sessionEvents.$inferSelect;

/** Insert value shape (no `id` — it's auto-generated). */
type SessionEventInsert = typeof sessionEvents.$inferInsert;

/** Append a new event for a session. */
export async function appendSessionEvent(
  db: Db,
  event: Omit<SessionEventInsert, "id">,
): Promise<void> {
  await db.insert(sessionEvents).values(event);
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
