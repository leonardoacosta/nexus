import type { Database } from "bun:sqlite";

/** Row shape stored in the `sessions` table. */
export interface SessionRow {
  id: string;
  project: string;
  machine: string;
  status: string;
  started_at: string;
  last_activity: string;
  ended_at: string | null;
  pid: number | null;
  cwd: string | null;
}

/** Insert a new session row. */
export function insertSession(db: Database, session: SessionRow): void {
  db.query(
    `INSERT INTO sessions (id, project, machine, status, started_at, last_activity, ended_at, pid, cwd)
     VALUES ($id, $project, $machine, $status, $started_at, $last_activity, $ended_at, $pid, $cwd)`,
  ).run({
    $id: session.id,
    $project: session.project,
    $machine: session.machine,
    $status: session.status,
    $started_at: session.started_at,
    $last_activity: session.last_activity,
    $ended_at: session.ended_at,
    $pid: session.pid,
    $cwd: session.cwd,
  });
}

/**
 * Update a session's status (and optionally last_activity).
 * When the new status is "ended", `ended_at` is automatically set.
 */
export function updateSessionStatus(
  db: Database,
  id: string,
  status: string,
  lastActivity?: string,
): void {
  const now = lastActivity ?? new Date().toISOString();
  const endedAt = status === "ended" ? now : null;

  db.query(
    `UPDATE sessions
     SET status = $status,
         last_activity = $last_activity,
         ended_at = COALESCE($ended_at, ended_at)
     WHERE id = $id`,
  ).run({
    $status: status,
    $last_activity: now,
    $ended_at: endedAt,
    $id: id,
  });
}

/** Return all sessions with status 'active' or 'idle'. */
export function queryActiveSessions(db: Database): SessionRow[] {
  return db
    .query(
      `SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY last_activity DESC`,
    )
    .all() as SessionRow[];
}

/**
 * Return sessions that were active within the last `hours` hours
 * (includes currently active ones).
 */
export function queryRecentSessions(
  db: Database,
  hours: number = 24,
): SessionRow[] {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  return db
    .query(
      `SELECT * FROM sessions WHERE last_activity >= $cutoff ORDER BY last_activity DESC`,
    )
    .all({ $cutoff: cutoff }) as SessionRow[];
}

/** Get a single session by id, or null if not found. */
export function getSessionById(
  db: Database,
  id: string,
): SessionRow | null {
  return (
    (db.query(`SELECT * FROM sessions WHERE id = $id`).get({ $id: id }) as
      | SessionRow
      | undefined) ?? null
  );
}
