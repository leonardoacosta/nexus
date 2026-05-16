import type { Db } from "@nexus/db";
import { sessions } from "@nexus/db";
import {
  eq,
  isNull,
  isNotNull,
  inArray,
  gte,
  desc,
  and,
  or,
  gt,
  ne,
} from "drizzle-orm";
import type { Session } from "@nexus/core";
import { narrowSessionStatus, narrowSessionType } from "@nexus/core";

/**
 * Drizzle predicate matching the "real CC session" fingerprint used by
 * `GET /sessions?withFingerprint=true` and the process-watcher reconciler.
 * A row is fingerprinted when ANY of the following holds:
 *   - `pid > 0`
 *   - `tmux_target IS NOT NULL AND tmux_target != ''`
 *   - `cc_session_id IS NOT NULL AND cc_session_id != ''`
 *   - `cwd IS NOT NULL AND cwd != ''`
 *
 * See: openspec/changes/fix-agent-cc-session-tracking/specs/session-persistence/spec.md
 */
const withFingerprintPredicate = or(
  gt(sessions.pid, 0),
  and(isNotNull(sessions.tmuxTarget), ne(sessions.tmuxTarget, "")),
  and(isNotNull(sessions.ccSessionId), ne(sessions.ccSessionId, "")),
  and(isNotNull(sessions.cwd), ne(sessions.cwd, "")),
);

/** Row shape returned from the `sessions` table. */
export type SessionRow = typeof sessions.$inferSelect;

/** Insert a new session row. */
export async function insertSession(db: Db, session: SessionRow): Promise<void> {
  await db.insert(sessions).values(session);
}

// ── Write-through helpers ──────────────────────────────────────────────────

/**
 * Load all sessions that have not ended (ended_at IS NULL).
 * Used for startup recovery — populates the in-memory cache.
 */
export async function loadActiveSessions(db: Db): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(isNull(sessions.endedAt))
    .orderBy(desc(sessions.lastActivity));

  return rows.map(rowToSession);
}

/**
 * INSERT a session or UPDATE it if the ID already exists.
 * Used by session-manager for write-through.
 */
export async function upsertSession(db: Db, session: Session): Promise<void> {
  const row = sessionToRow(session);
  await db
    .insert(sessions)
    .values(row)
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        projectId: row.projectId,
        machine: row.machine,
        status: row.status,
        lastActivity: row.lastActivity,
        endedAt: row.endedAt,
        pid: row.pid,
        cwd: row.cwd,
        branch: row.branch,
        sessionType: row.sessionType,
        model: row.model,
        rateLimitUtilization: row.rateLimitUtilization,
        totalCostUsd: row.totalCostUsd,
        ccSessionId: row.ccSessionId,
        tmuxSession: row.tmuxSession,
        tmuxTarget: row.tmuxTarget,
        spec: row.spec,
        credentialId: row.credentialId,
        credentialFingerprint: row.credentialFingerprint,
      },
    });
}

// ── Mapping helpers ────────────────────────────────────────────────────────

/** Convert a DB row to the in-memory Session type. */
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    pid: row.pid ?? 0,
    // `project` (name) requires a join on projects.id — left undefined here.
    // Consumers needing the project name should load it via a separate query.
    project: undefined,
    projectId: row.projectId ?? null,
    machine: row.machine ?? null,
    cwd: row.cwd ?? "",
    branch: row.branch ?? null,
    startedAt: row.startedAt,
    lastHeartbeat: row.lastActivity,
    endedAt: row.endedAt ?? null,
    status: narrowSessionStatus(row.status, "active"),
    spec: row.spec ?? null,
    command: null,
    agent: null,
    tmuxSession: row.tmuxSession ?? null,
    ccSessionId: row.ccSessionId ?? null,
    tmuxTarget: row.tmuxTarget ?? null,
    rateLimitUtilization: row.rateLimitUtilization ?? null,
    rateLimitType: null,
    totalCostUsd: row.totalCostUsd ?? null,
    model: row.model ?? null,
    credentialId: row.credentialId ?? null,
    credentialFingerprint: row.credentialFingerprint ?? null,
    sessionType: narrowSessionType(row.sessionType),
  };
}

/** Convert the in-memory Session type to a DB row shape. */
function sessionToRow(session: Session): SessionRow {
  return {
    id: session.id,
    machine: session.machine ?? "",
    status: session.status,
    startedAt: session.startedAt,
    lastActivity: session.lastHeartbeat,
    endedAt: session.endedAt ?? null,
    pid: session.pid ?? null,
    cwd: session.cwd ?? null,
    branch: session.branch ?? null,
    sessionType: session.sessionType ?? null,
    model: session.model ?? null,
    rateLimitUtilization: session.rateLimitUtilization ?? null,
    totalCostUsd: session.totalCostUsd ?? null,
    rateLimitResetAt: null,
    idleSince: null,
    projectId: session.projectId ?? null,
    ccSessionId: session.ccSessionId ?? null,
    tmuxSession: session.tmuxSession ?? null,
    tmuxTarget: session.tmuxTarget ?? null,
    spec: session.spec ?? null,
    credentialId: session.credentialId ?? null,
    credentialFingerprint: session.credentialFingerprint ?? null,
  };
}

/**
 * Update a session's status (and optionally last_activity).
 * When the new status is "ended", `ended_at` is automatically set.
 */
export async function updateSessionStatus(
  db: Db,
  id: string,
  status: string,
  lastActivity?: Date,
): Promise<void> {
  const now = lastActivity ?? new Date();
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
export async function queryActiveSessions(
  db: Db,
  opts?: { withFingerprint?: boolean },
): Promise<SessionRow[]> {
  const statusPredicate = inArray(sessions.status, ["active", "idle"]);
  const predicate = opts?.withFingerprint
    ? and(statusPredicate, withFingerprintPredicate)
    : statusPredicate;
  return db
    .select()
    .from(sessions)
    .where(predicate)
    .orderBy(desc(sessions.lastActivity));
}

/**
 * Return sessions that were active within the last `hours` hours
 * (includes currently active ones).
 */
export async function queryRecentSessions(
  db: Db,
  hours: number = 24,
  opts?: { withFingerprint?: boolean },
): Promise<SessionRow[]> {
  const cutoff = new Date(Date.now() - hours * 3600_000);
  const cutoffPredicate = gte(sessions.lastActivity, cutoff);
  const predicate = opts?.withFingerprint
    ? and(cutoffPredicate, withFingerprintPredicate)
    : cutoffPredicate;
  return db
    .select()
    .from(sessions)
    .where(predicate)
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
