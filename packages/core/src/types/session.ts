/**
 * Domain-level Session types for the Nexus application layer.
 *
 * `Session` is derived from the Drizzle `$inferSelect` shape of `sessionsTable`
 * via `Pick` + override + computed runtime fields. This ensures the domain type
 * stays in sync with the DB schema as the source of truth.
 *
 * Derivation strategy (per design.md):
 *   1. `SessionDbBase`   — Pick the 17 directly-safe columns (no cast needed)
 *   2. `SessionDbOverrides` — Override the 5 fields whose DB type is wider than
 *      the domain wants (enum narrowing, nullable → non-null coercions)
 *   3. `SessionRuntimeFields` — 5 computed fields with no direct DB column
 *   4. `Session` = Omit<SessionDbBase, overridden keys> & overrides & runtime
 */

import type { sessions as sessionsTable } from "@nexus/db";

// ---------------------------------------------------------------------------
// Step 1: Pick the directly-safe columns from the DB row.
//
// Excluded columns and reasons:
//   status         — text in DB; domain uses a union literal (needs runtime narrowing)
//   sessionType    — text | null in DB; domain uses a union literal (needs narrowing)
//   lastActivity   — renamed to lastHeartbeat in domain
//   rateLimitResetAt — not surfaced in domain Session
//   idleSince      — not surfaced in domain Session
// ---------------------------------------------------------------------------
type SessionDbBase = Pick<
  typeof sessionsTable.$inferSelect,
  | "id"
  | "projectId"
  | "machine"
  | "cwd"
  | "branch"
  | "startedAt"
  | "endedAt"
  | "pid"
  | "spec"
  | "tmuxSession"
  | "ccSessionId"
  | "tmuxTarget"
  | "rateLimitUtilization"
  | "model"
  | "credentialId"
  | "credentialFingerprint"
  // Sub-agent tree fields — add-subagent-tree-columns. Both nullable in DB
  // (top-level sessions have no parent), no narrowing needed.
  | "parentSessionId"
  | "childRole"
>;

// ---------------------------------------------------------------------------
// Step 2: Override fields whose DB type is wider than the domain requires.
//
//   status        — DB: string (unconstrained text); domain: SessionStatus union
//   sessionType   — DB: string | null; domain: SessionType (non-null union)
//   machine       — DB: string (NOT NULL); domain: string | null (explicit widening)
//   cwd           — DB: string | null; domain: string (mapper must fallback to "")
//   pid           — DB: number | null; domain: number (mapper must fallback to 0)
// ---------------------------------------------------------------------------
type SessionDbOverrides = {
  /** DB: text (unconstrained). Mapper must narrow at runtime or throw on unknown value. */
  status: SessionStatus;
  /**
   * DB: text | null (unconstrained). Mapper must narrow at runtime via
   * `narrowAgentState`, preserving null. ORTHOGONAL to `status` — this is the
   * CC-hook-derived agent activity axis (blocked|waiting|ready), not the
   * lifecycle/liveness axis. session-enrichment.
   */
  agentState: AgentState | null;
  /** DB: text | null. Mapper must narrow at runtime; fallback to "ad_hoc" on null. */
  sessionType: SessionType;
  /** DB: string NOT NULL. Domain widens to nullable — safe (no cast required). */
  machine: string | null;
  /** DB: string | null. Mapper must provide fallback "" for non-null domain. */
  cwd: string;
  /** DB: number | null. Mapper must provide fallback (0 or -1) for non-null domain. */
  pid: number;
};

// ---------------------------------------------------------------------------
// Step 3: Computed runtime fields — no direct DB column.
// ---------------------------------------------------------------------------

/**
 * Fields present on the domain `Session` type that have no corresponding
 * column in the `sessions` table. These are populated by the mapper at
 * query time (via JOINs or runtime derivation) and are never persisted.
 */
export type SessionRuntimeFields = {
  /**
   * Alias of `sessions.lastActivity`. The DB column is `last_activity`;
   * the domain exposes it as `lastHeartbeat` to avoid confusion with
   * application-level "activity" events.
   */
  lastHeartbeat: Date;
  /**
   * Human-readable project name from a `projects` JOIN.
   * Absent when no JOIN was performed (raw row mapping without project lookup).
   * Consumers needing the canonical identifier should prefer `projectId`.
   */
  project?: string | null;
  /**
   * Not stored in the DB — derived from external session metadata or session
   * events (e.g. the initial `claude` command that started the session).
   */
  command: string | null;
  /**
   * Not stored in the DB — derived from an `agents` JOIN or runtime config
   * lookup. Typically matches `machine` when populated.
   */
  agent: string | null;
  /**
   * Not stored in the DB — derived from the credential tier or rate-limit
   * event associated with this session.
   */
  rateLimitType: string | null;
};

// ---------------------------------------------------------------------------
// Step 4: Compose the final domain type.
// ---------------------------------------------------------------------------

/**
 * A Claude Code session running on a specific machine.
 *
 * Derived from `sessionsTable.$inferSelect` with:
 *   - Type-narrowed overrides for enum columns (`status`, `sessionType`)
 *   - Non-null coercions for nullable DB columns (`cwd`, `pid`)
 *   - Runtime-computed fields that have no DB column (`lastHeartbeat`, etc.)
 */
export type Session = Omit<SessionDbBase, keyof SessionDbOverrides> &
  SessionDbOverrides &
  SessionRuntimeFields;

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

/**
 * Valid values for `sessions.status`.
 *
 * DB column is unconstrained `text` — any string can be stored. The mapper
 * MUST call `narrowSessionStatus()` rather than using `as SessionStatus` casts,
 * so unknown values throw clearly instead of silently propagating bad data.
 */
export type SessionStatus = "active" | "idle" | "ended" | "stale" | "errored";

/**
 * Valid values for `sessions.agent_state` (session-enrichment).
 *
 * ORTHOGONAL to `SessionStatus` — `status` is the lifecycle/liveness axis
 * (active|idle|ended|stale|errored), `agentState` is the CC-hook-derived
 * activity axis describing whether the agent can take a command right now:
 *   - `blocked` — mid-turn / running a tool (PreToolUse, PostToolUse,
 *     UserPromptSubmit, SubagentStart).
 *   - `waiting` — awaiting user input (permission prompt / idle Notification).
 *   - `ready`   — turn ended, awaiting next prompt (Stop).
 *
 * DB column is unconstrained `text | null`. The mapper MUST call
 * `narrowAgentState()` rather than using `as AgentState` casts. `null` means
 * "no hook observed yet" and renders as today's behavior on the dashboard.
 */
export type AgentState = "blocked" | "waiting" | "ready";

/**
 * Valid values for `sessions.session_type`.
 *
 * DB column is unconstrained `text | null`. The mapper MUST call
 * `narrowSessionType()` rather than using `as SessionType` casts.
 */
export type SessionType = "ad_hoc" | "managed" | "pooled";

// ---------------------------------------------------------------------------
// Runtime narrowing helpers
//
// These replace the unsafe `as Session["status"]` / `as Session["sessionType"]`
// casts in the mapper. They throw on unexpected values instead of silently
// propagating invalid data — providing early failure on enum drift from old
// agent versions writing unknown strings.
// ---------------------------------------------------------------------------

const SESSION_STATUSES = new Set<SessionStatus>([
  "active",
  "idle",
  "ended",
  "stale",
  "errored",
]);

const SESSION_TYPES = new Set<SessionType>(["ad_hoc", "managed", "pooled"]);

const AGENT_STATES = new Set<AgentState>(["blocked", "waiting", "ready"]);

/**
 * Narrow a raw DB string (or null) to `AgentState | null`.
 *
 * Null-preserving: `null`/`undefined` map to `null` (no hook observed yet),
 * mirroring the additive, backward-compatible contract. Unknown non-null
 * values also degrade to `null` rather than throwing — `agentState` is a soft
 * display signal, so enum drift from an old agent version MUST NOT break a
 * sessions query (unlike `status`, which throws because liveness is critical).
 */
export function narrowAgentState(
  value: string | null | undefined,
): AgentState | null {
  if (value == null) return null;
  if (AGENT_STATES.has(value as AgentState)) return value as AgentState;
  return null;
}

/**
 * Narrow a raw DB string to `SessionStatus`.
 * Falls back to `defaultValue` when provided; throws when the value is
 * unrecognised and no default is given.
 */
export function narrowSessionStatus(
  value: string | null | undefined,
  defaultValue?: SessionStatus,
): SessionStatus {
  if (value != null && SESSION_STATUSES.has(value as SessionStatus)) {
    return value as SessionStatus;
  }
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Unknown session status: "${value}"`);
}

/**
 * Narrow a raw DB string (or null) to `SessionType`.
 * Defaults to `"ad_hoc"` on null/undefined (matches original mapper behaviour).
 * Throws on an unrecognised non-null value.
 */
export function narrowSessionType(
  value: string | null | undefined,
): SessionType {
  if (value == null) return "ad_hoc";
  if (SESSION_TYPES.has(value as SessionType)) return value as SessionType;
  throw new Error(`Unknown session type: "${value}"`);
}
