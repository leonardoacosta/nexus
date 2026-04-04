import type { Db } from "@nexus/db";
import { sessions } from "@nexus/db";
import { eq, inArray, gte, desc } from "drizzle-orm";

/** Row shape returned from the `sessions` table. */
export type SessionRow = typeof sessions.$inferSelect;

/** Insert a new session row. */
export async function insertSession(db: Db, session: SessionRow): Promise<void> {
  await db.insert(sessions).values(session);
}

/**
 * Update a session's status (and optionally last_activity).
 * When the new status is "ended", `ended_at` is automatically set.
 */
export async function updateSessionStatus(
  db: Db,
  id: string,
  status: string,
  lastActivity?: string,
): Promise<void> {
  const now = lastActivity ?? new Date().toISOString();
  const endedAt = status === "ended" ? now : undefined;

  await db
    .update(sessions)
    .set({
      status,
      lastActivity: now,
      ...(endedAt !== undefined ? { endedAt } : {}),
    })
    .where(eq(sessions.id, id));
}

/** Return all sessions with status 'active' or 'idle'. */
export async function queryActiveSessions(db: Db): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .where(inArray(sessions.status, ["active", "idle"]))
    .orderBy(desc(sessions.lastActivity));
}

/**
 * Return sessions that were active within the last `hours` hours
 * (includes currently active ones).
 */
export async function queryRecentSessions(
  db: Db,
  hours: number = 24,
): Promise<SessionRow[]> {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  return db
    .select()
    .from(sessions)
    .where(gte(sessions.lastActivity, cutoff))
    .orderBy(desc(sessions.lastActivity));
}

/** Get a single session by id, or null if not found. */
export async function getSessionById(
  db: Db,
  id: string,
): Promise<SessionRow | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ?? null;
}
