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
import type { Session, AgentState } from "@nexus/core";
import {
  narrowSessionStatus,
  narrowSessionType,
  narrowAgentState,
} from "@nexus/core";

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
        ccSessionId: row.ccSessionId,
        tmuxSession: row.tmuxSession,
        tmuxTarget: row.tmuxTarget,
        spec: row.spec,
        credentialId: row.credentialId,
        credentialFingerprint: row.credentialFingerprint,
        gitProvider: row.gitProvider,
        gitOwnerRepo: row.gitOwnerRepo,
        agentState: row.agentState,
        parentSessionId: row.parentSessionId,
        childRole: row.childRole,
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
    model: row.model ?? null,
    credentialId: row.credentialId ?? null,
    credentialFingerprint: row.credentialFingerprint ?? null,
    sessionType: narrowSessionType(row.sessionType),
    // session-enrichment: null-preserving narrowing — unknown/absent → null.
    agentState: narrowAgentState(row.agentState),
    parentSessionId: row.parentSessionId ?? null,
    childRole: row.childRole ?? null,
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
    // Stop-reason fields (nx-f060f). Not surfaced on the domain Session type;
    // persisted directly via `recordSessionStop` from the dispatcher. Falling
    // through as null here is correct — the writer path owns these fields.
    stopReason: null,
    errorDetails: null,
    pid: session.pid ?? null,
    cwd: session.cwd ?? null,
    branch: session.branch ?? null,
    sessionType: session.sessionType ?? null,
    model: session.model ?? null,
    rateLimitUtilization: session.rateLimitUtilization ?? null,
    rateLimitResetAt: null,
    idleSince: null,
    projectId: session.projectId ?? null,
    ccSessionId: session.ccSessionId ?? null,
    tmuxSession: session.tmuxSession ?? null,
    tmuxTarget: session.tmuxTarget ?? null,
    spec: session.spec ?? null,
    credentialId: session.credentialId ?? null,
    credentialFingerprint: session.credentialFingerprint ?? null,
    // Agent-state field (session-enrichment). Round-tripped from the domain
    // Session so an upsert never clobbers a previously-derived state with
    // null. The hook-driven writer path is `updateSessionAgentState`.
    agentState: session.agentState ?? null,
    // Git origin fields (add-git-project-resolver). Not surfaced on the
    // domain Session type; persisted directly via `updateSessionGitOrigin`
    // from `services/process-hook-event.ts`. Falling through as null here
    // is correct — the writer path that owns these fields is the helper.
    gitProvider: null,
    gitOwnerRepo: null,
    // Sub-agent tree fields (add-subagent-tree-columns). Populated from
    // the in-memory Session, which is patched by `updateLinkage`.
    parentSessionId: session.parentSessionId ?? null,
    childRole: session.childRole ?? null,
  };
}

/**
 * Persist git origin metadata for a session.
 *
 * Used by `services/process-hook-event.ts` on `session_start` after
 * `resolveGitOrigin(cwd)` returns a non-null result. Bypasses the in-memory
 * Session type (which does not surface git fields per its `Pick<>` derivation)
 * and writes directly to the DB row.
 *
 * Spec: openspec/changes/add-git-project-resolver 1.3.
 */
export async function updateSessionGitOrigin(
  db: Db,
  sessionId: string,
  origin: { provider: string; ownerRepo: string },
): Promise<void> {
  await db
    .update(sessions)
    .set({
      gitProvider: origin.provider,
      gitOwnerRepo: origin.ownerRepo,
    })
    .where(eq(sessions.id, sessionId));
}

/**
 * Backfill a session row's `cwd` from a hook-supplied value — but ONLY when
 * the row's current cwd is empty/null.
 *
 * Why this exists: the process-watcher creates a session row with an EMPTY
 * cwd whenever it discovers a live `claude` PID that didn't match a tmux pane
 * (see process-watcher.ts — "cwd is empty and enrichment is deferred to a
 * later poll once a hook supplies cwd"). cwd is hook-authoritative: the
 * watcher is intentionally /proc-free under Yama=1 user-instance systemd
 * (nx-9jz0v), so the only source for that row's cwd is a subsequent CC
 * `session_start` (or other cwd-carrying) hook.
 *
 * Idempotent + safe: the WHERE clause matches only rows whose cwd IS NULL or
 * '', so a real cwd (set by tmux backfill or an earlier hook) is NEVER
 * clobbered by a later differing hook value. Returns the number of rows
 * touched (0 when the row already had a cwd or does not exist).
 *
 * Spec: re-scoped nx-cvyxt (empty-cwd backfill from the session_start hook).
 */
export async function backfillSessionCwd(
  db: Db,
  sessionId: string,
  cwd: string,
): Promise<number> {
  // Never write a blank value — that would be a no-op at best and could
  // mask a real cwd at worst if the predicate ever loosened.
  if (!cwd.trim()) return 0;
  // `.returning()` gives a driver-agnostic affected-row count: postgres-js
  // does not populate the node-postgres `rowCount` field, so we count the
  // returned ids instead (RETURNING only emits rows that actually matched
  // the WHERE clause).
  const updated = await db
    .update(sessions)
    .set({ cwd })
    .where(
      and(
        eq(sessions.id, sessionId),
        or(isNull(sessions.cwd), eq(sessions.cwd, "")),
      ),
    )
    .returning({ id: sessions.id });
  return updated.length;
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

/**
 * Record a session stop: set `ended_at = now` and persist the stop-reason
 * fields (nx-f060f). Mirrors the targeted-UPDATE idiom of
 * `updateSessionGitOrigin` / `updateSessionStatus` — a single keyed write that
 * bypasses the in-memory Session type (which does not surface these fields).
 *
 * `stopReason` / `errorDetails` are written directly from `opts`; both are
 * nullable, so an absent value writes `null` (the default column state) rather
 * than clobbering nothing — the dispatcher always supplies them on a stop.
 */
export async function recordSessionStop(
  db: Db,
  sessionId: string,
  opts: { stopReason?: string; errorDetails?: string },
): Promise<void> {
  await db
    .update(sessions)
    .set({
      endedAt: new Date(),
      stopReason: opts.stopReason ?? null,
      errorDetails: opts.errorDetails ?? null,
    })
    .where(eq(sessions.id, sessionId));
}

/**
 * Map a Claude Code lifecycle hook event name to the session `agentState`
 * it implies (session-enrichment).
 *
 *   - PreToolUse | PostToolUse | UserPromptSubmit | SubagentStart → `blocked`
 *     (mid-turn / running a tool).
 *   - Notification (awaiting user input — permission prompt / idle)  → `waiting`.
 *   - Stop  → `ready` (turn ended, awaiting next prompt).
 *
 * Returns `null` for any other event name — the caller MUST treat null as "this
 * hook carries no agent-state signal" and skip the persist (do NOT clobber the
 * existing state with null).
 *
 * Accepts the canonical CC hook names AND the agent's snake_case socket-event
 * aliases so the dispatcher can pass either form:
 *   - `session_heartbeat` ≡ a mid-turn tool hook (the dispatcher's view of the
 *     PreToolUse/PostToolUse/UserPromptSubmit/SubagentStart stream) → `blocked`
 *   - `notification`      ≡ `Notification` → `waiting`
 *   - `session_stop`      ≡ `Stop`         → `ready`
 */
export function deriveAgentState(eventType: string): AgentState | null {
  switch (eventType) {
    case "PreToolUse":
    case "PostToolUse":
    case "UserPromptSubmit":
    case "SubagentStart":
    case "session_heartbeat":
      return "blocked";
    case "Notification":
    case "notification":
      return "waiting";
    case "Stop":
    case "session_stop":
      return "ready";
    default:
      return null;
  }
}

/**
 * Persist a session's `agent_state` column, keyed by session id
 * (session-enrichment). Used by the hook-processing spine on every lifecycle
 * hook that carries an agent-state signal (see `deriveAgentState`).
 *
 * Idempotent and cheap — a single targeted UPDATE. Does NOT touch
 * `last_activity` or `status`: agentState is orthogonal to the liveness axis,
 * and the heartbeat / status writers own those columns. Returns the number of
 * rows touched (0 when the session id does not exist).
 */
export async function updateSessionAgentState(
  db: Db,
  id: string,
  agentState: AgentState,
): Promise<number> {
  const updated = await db
    .update(sessions)
    .set({ agentState })
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id });
  return updated.length;
}

/**
 * Persist a session's raw `model` string, keyed by session id
 * (add-session-model-authority). Called from the hook-ingest spine on any event
 * carrying a fresh model value (`session_start`, `session_heartbeat`),
 * last-write-wins — a later event's value replaces an earlier one.
 *
 * No-clobber guard: an empty/blank `model` is a no-op (returns 0) so a hook
 * that omits the field never overwrites a previously-stored model with "".
 * Mirrors the fail-soft, single-targeted-UPDATE shape of
 * `updateSessionAgentState`. Stores the RAW value (not a derived letter) so a
 * future change to the family-mapping heuristic never needs a data backfill.
 * Returns the number of rows touched (0 when blank, or the id does not exist).
 */
export async function updateSessionModel(
  db: Db,
  id: string,
  model: string,
): Promise<number> {
  if (!model || !model.trim()) return 0;
  const updated = await db
    .update(sessions)
    .set({ model })
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id });
  return updated.length;
}

/**
 * Persist a session row's `cc_session_id` bridge column, keyed by nx's own
 * `sessions.id` (universe 1). This is the write half of the universe-1 ->
 * universe-2 bridge (fix-cc-session-id-bridge, nx-22xz8): `sessions.ccSessionId`
 * was declared on the schema and the `cc_session_id` field was already arriving
 * on `SessionStartEvent`, but nothing ever wrote it — `handleGetSessionContext`
 * (keyed by CC's raw session id, universe 2) could therefore never resolve a
 * row via `getSessionByCcSessionId` below.
 *
 * No-clobber guard: an empty/blank `ccSessionId` is a no-op (returns 0) so a
 * hook payload that omits `cc_session_id` never overwrites a previously-bound
 * value with "". Mirrors the fail-soft, single-targeted-UPDATE shape of
 * `updateSessionModel`. Returns the number of rows touched (0 when blank, or
 * the id does not exist).
 */
export async function updateSessionCcSessionId(
  db: Db,
  id: string,
  ccSessionId: string,
): Promise<number> {
  if (!ccSessionId || !ccSessionId.trim()) return 0;
  const updated = await db
    .update(sessions)
    .set({ ccSessionId })
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id });
  return updated.length;
}

/**
 * Refresh `last_activity = now` for every open, active session whose `pid`
 * is in `pids`. This is a liveness heartbeat sourced from process-aliveness
 * (the process-watcher reconcile tick), NOT from inbound CC hook traffic — a
 * long-running session between hook events would otherwise go stale and the
 * Swift dashboard's 300s freshness window would drop it.
 *
 * Single batched UPDATE (one query for the whole pid set). No-op when `pids`
 * is empty. Only touches rows that are still `status = 'active'` with
 * `ended_at IS NULL` so a dead/closed row is never resurrected.
 */
export async function touchHeartbeatByPids(
  db: Db,
  pids: number[],
): Promise<void> {
  if (pids.length === 0) return;
  await db
    .update(sessions)
    .set({ lastActivity: new Date() })
    .where(
      and(
        inArray(sessions.pid, pids),
        eq(sessions.status, "active"),
        isNull(sessions.endedAt),
      ),
    );
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

/**
 * Get a single session row by its `cc_session_id` bridge column (universe 2 —
 * Claude Code's own raw hook session id), or null if no row has been bound to
 * it yet. Companion read to `updateSessionCcSessionId` above
 * (fix-cc-session-id-bridge, nx-22xz8).
 *
 * Callers that only have CC's raw session id in hand (e.g.
 * `handleGetSessionContext`, `context-guard.ts`, `cc-tmux`) MUST resolve via
 * this helper rather than `getSessionById`, which queries the primary key
 * (nx's own internal `sessions.id`, universe 1) — a different value for any
 * session created via the file-watcher or HTTP session-start paths.
 */
export async function getSessionByCcSessionId(
  db: Db,
  ccSessionId: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.ccSessionId, ccSessionId))
    .limit(1);
  return rows[0] ?? null;
}
