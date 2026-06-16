/**
 * TypeScript types for the Unix domain socket protocol.
 *
 * These match the Rust `SocketEvent` and `SocketCommand` enums in
 * `crates/nexus-core/src/socket_event.rs` exactly. The `event` field
 * is the discriminant tag (snake_case), matching serde's
 * `#[serde(tag = "event", rename_all = "snake_case")]`.
 */

// ---------------------------------------------------------------------------
// Socket Events (fire-and-forget, hook -> agent)
// ---------------------------------------------------------------------------

export interface SessionStartEvent {
  event: "session_start";
  session_id: string;
  project?: string;
  cwd?: string;
  model?: string;
  pid?: number;
  branch?: string;
  cc_session_id?: string;
  tmux_target?: string;
  /** Credential fingerprint (SHA-256 of refresh token) for session-credential binding. */
  credential_fingerprint?: string;
}

export interface SessionStopEvent {
  event: "session_stop";
  session_id: string;
  /**
   * Why the session stopped. Sent today on the wire by the CC Stop hook but
   * previously untyped; one of {error, api_error, crash, timeout, oom} marks a
   * crash (see `notifications/hook-rules.ts` CRASH_STOP_REASONS). Persisted to
   * `sessions.stop_reason` via `recordSessionStop` (nx-f060f).
   */
  stop_reason?: string;
  /**
   * Free-form error text captured by the CC hook (e.g. "API Error: 529
   * Overloaded"). Persisted to `sessions.error_details` and surfaced in the
   * crash notification body (nx-f060f).
   */
  error_details?: string;
}

export interface SessionHeartbeatEvent {
  event: "session_heartbeat";
  session_id: string;
}

export interface NotificationEvent {
  event: "notification";
  message: string;
  message_type?: string;
  channels?: string[];
  /**
   * Originating project slug. Identifies which project emitted this notification
   * (e.g., `"nova"`, `"nx"`, `"cc"`, `"oo"`). Used by downstream channels
   * (tts, slack, etc.) to attribute output to the source project.
   *
   * @remarks
   * MAY be omitted, `null`, or the empty string `""` — all three cases are
   * treated equivalently as "no project context" by downstream channels
   * (no default substitution, no `"nexus"` fallback).
   *
   * @example
   * Shell sender (derives from current working directory):
   * ```sh
   * echo "{\"event\":\"notification\",\"message\":\"build done\",\"project\":\"$(basename \"$PWD\")\"}" \
   *   | socat - UNIX-CONNECT:/tmp/nexus-agent.sock
   * ```
   *
   * @example
   * TypeScript sender:
   * ```ts
   * const evt: NotificationEvent = {
   *   event: "notification",
   *   message: "build done",
   *   project: "nx",
   * };
   * ```
   */
  project?: string;
  question?: string;
  session_id?: string;
}

export interface AnswerEvent {
  event: "answer";
  text: string;
  session_id?: string;
}

export interface AgentSpawnEvent {
  event: "agent_spawn";
  session_id?: string;
  agent_type?: string;
  model?: string;
  /**
   * Parent session id when this spawn was initiated by another agent.
   * Wired into `sessions.parent_session_id` via
   * `services/process-hook-event.ts` (add-subagent-tree-columns 1.3).
   * Also accepts `parent_agent` for back-compat with CC hook payloads
   * (see `scripts/backfill-subagent-tree.ts`).
   */
  parent_session_id?: string;
  parent_agent?: string;
  /**
   * Free-form role label from CC `agent_spawn` events (e.g. "explore",
   * "verify"). Persisted to `sessions.child_role`.
   */
  child_role?: string;
}

export interface AgentCompleteEvent {
  event: "agent_complete";
  session_id?: string;
  agent_type?: string;
  duration_ms?: number;
}

export interface TelemetryEvent {
  event: "telemetry";
  payload: Record<string, unknown>;
}

export interface SessionSummaryEvent {
  event: "session_summary";
  session_id: string;
  project?: string;
  tool_counts?: Record<string, number>;
  failure_count?: number;
  compaction_count?: number;
  agent_spawns?: number;
  duration_ms?: number;
  model?: string;
}

export interface DeployStatusEvent {
  event: "deploy_status";
  project: string;
  status: string;
  message?: string;
  target?: string;
  service?: string;
}

/** Discriminated union of all socket events. */
export type SocketEvent =
  | SessionStartEvent
  | SessionStopEvent
  | SessionHeartbeatEvent
  | NotificationEvent
  | AnswerEvent
  | AgentSpawnEvent
  | AgentCompleteEvent
  | TelemetryEvent
  | SessionSummaryEvent
  | DeployStatusEvent;

// ---------------------------------------------------------------------------
// Socket Commands (request/response, client -> agent -> client)
// ---------------------------------------------------------------------------

export interface ModeQueryCommand {
  command: "mode_query";
}

export interface ModeSetCommand {
  command: "mode_set";
  mode: string;
}

export interface ModeCycleCommand {
  command: "mode_cycle";
}

export interface HistoryCommand {
  command: "history";
  limit?: number;
}

export interface TypeSetCommand {
  command: "type_set";
  name: string;
  mode: string;
}

export interface TypeClearCommand {
  command: "type_clear";
  name: string;
}

export interface NotificationRulesCommand {
  command: "notification_rules";
  project?: string;
}

export interface NotificationSetCommand {
  command: "notification_set";
  project: string;
  verbosity?: string;
  announce_agents?: boolean;
  announce_specs?: boolean;
  announce_sessions?: boolean;
  reset_to_default?: boolean;
}

/** Discriminated union of all socket commands. */
export type SocketCommand =
  | ModeQueryCommand
  | ModeSetCommand
  | ModeCycleCommand
  | HistoryCommand
  | TypeSetCommand
  | TypeClearCommand
  | NotificationRulesCommand
  | NotificationSetCommand;

// ---------------------------------------------------------------------------
// Socket Responses (agent -> client)
// ---------------------------------------------------------------------------

export interface ModeQueryResponse {
  mode: string;
}

export interface ModeChangedResponse {
  mode: string;
  previous: string;
}

export interface HistoryResponse {
  items: unknown[];
}

export interface TypeSetResponse {
  type: string;
  mode: string;
}

export interface TypeClearedResponse {
  cleared: string;
}

export interface RulesResponse {
  [key: string]: unknown;
}

export interface OkResponse {
  ok: boolean;
  project: string;
}

export interface ErrorResponse {
  error: string;
}

export type SocketResponse =
  | ModeQueryResponse
  | ModeChangedResponse
  | HistoryResponse
  | TypeSetResponse
  | TypeClearedResponse
  | RulesResponse
  | OkResponse
  | ErrorResponse;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const VALID_EVENTS = new Set([
  "session_start",
  "session_stop",
  "session_heartbeat",
  "notification",
  "answer",
  "agent_spawn",
  "agent_complete",
  "telemetry",
  "session_summary",
  "deploy_status",
]);

const VALID_COMMANDS = new Set([
  "mode_query",
  "mode_set",
  "mode_cycle",
  "history",
  "type_set",
  "type_clear",
  "notification_rules",
  "notification_set",
]);

/** Type guard: returns true if the parsed JSON is a valid SocketEvent.
 *
 * CC hooks send `event_type` instead of `event` in their JSON payloads.
 * This guard normalises the field name so the rest of the dispatch chain
 * can rely on `event` being present.
 */
export function isSocketEvent(obj: unknown): obj is SocketEvent {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;

  // Normalize: CC hooks send "event_type", socket protocol expects "event"
  if (!("event" in rec) && "event_type" in rec && typeof rec.event_type === "string") {
    rec.event = rec.event_type;
  }

  return "event" in rec && typeof rec.event === "string" && VALID_EVENTS.has(rec.event as string);
}

/** Type guard: returns true if the parsed JSON is a valid SocketCommand. */
export function isSocketCommand(obj: unknown): obj is SocketCommand {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "command" in obj &&
    typeof (obj as Record<string, unknown>).command === "string" &&
    VALID_COMMANDS.has((obj as Record<string, unknown>).command as string)
  );
}
