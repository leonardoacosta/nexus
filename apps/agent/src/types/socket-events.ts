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
   * previously untyped; one of {error, crash, timeout, oom} marks a crash via
   * `crash_flag` / CRASH_STOP_REASONS (see `notifications/hook-rules.ts`).
   * `"api_error"` is also a crash, but is routed by
   * `dispatchStopNotification` to the separate `apiErrorRule` (desktop+tts)
   * instead — see `services/socket-server/dispatcher.ts` (nx-7tfim).
   * Persisted to `sessions.stop_reason` via `recordSessionStop` (nx-f060f).
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
  /**
   * Active model at heartbeat time. CC hook payloads carry `model` on every
   * invocation (not just SessionStart), so a mid-session `/model` switch shows
   * up here — persisted to `sessions.model` last-write-wins by the dispatcher
   * (add-session-model-authority). Optional: a heartbeat that omits it is a
   * no-op for model persistence (the value is never clobbered with "").
   */
  model?: string;
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

/**
 * Tool-execution failure (CC PostToolUse error). Routed to `toolUseFailRule`
 * (desktop, priority high) with a 30s per-tool suppression window. Field
 * aliases (`tool`/`tool_name`, `error`/`error_message`) mirror
 * `HookEventPayload` — rules read either upstream key. Added nx-z0vm4: this
 * event was silently dropped at `isSocketEvent` (never in `VALID_EVENTS`) so
 * the `add-hooks-notification-triggers` feature was dead in production from
 * 2026-04-27 until 2026-07-14.
 */
export interface ToolUseFailEvent {
  event: "tool_use_fail";
  session_id?: string;
  project?: string;
  tool?: string;
  tool_name?: string;
  error?: string;
  error_message?: string;
  command?: string;
}

/**
 * PostToolUse completion for Write|Edit|MultiEdit (CC hook `tool_use_end`).
 * Added nx-9qsmb.5 (Option B): the highest-frequency socket event during a
 * live session, wired through `processHookEvent` so its `transcript_path`
 * feeds the agent-side context-usage collector (nx-qayeb.1) on tool-call
 * cadence instead of only at session boundaries. `transcript_path` is only
 * populated as of `cc/scripts/hooks/telemetry.sh`'s matching nx-9qsmb.5 fix
 * (`handle_tool_use_end` previously dropped the field even though CC's raw
 * hook stdin always carries it) — absent/empty on events from an
 * unpatched sender, which the collector already treats as a no-op.
 */
export interface ToolUseEndEvent {
  event: "tool_use_end";
  session_id?: string;
  tool?: string;
  success?: boolean;
  agent_type?: string;
  duration_ms?: number;
  transcript_path?: string;
}

/**
 * Every user turn (CC hook `UserPromptSubmit`). Added nx-9qsmb.5 (Option B)
 * alongside `tool_use_end` — the other high-frequency event wired through
 * `processHookEvent` for the same context-usage-collector reason. Carries no
 * fields beyond the shared envelope + `transcript_path` (same caveat as
 * `ToolUseEndEvent` above re: sender-side patch dependency).
 */
export interface UserPromptEvent {
  event: "user_prompt";
  session_id?: string;
  transcript_path?: string;
}

/**
 * Permission prompt raised by CC (friction signal). Routed to
 * `permissionRequestRule` (desktop + tts, priority normal); never suppressed
 * (always fires). Added nx-z0vm4 alongside `tool_use_fail` / `hook_failure`.
 */
export interface PermissionRequestEvent {
  event: "permission_request";
  session_id?: string;
  project?: string;
  tool?: string;
  tool_name?: string;
  session_name?: string;
  cc_session_id?: string;
}

/**
 * CC hook handler failure. Routed to `hookFailureRule` (desktop, priority
 * high) with a 30s per-hook suppression window. `handler`/`hook_name` are
 * aliases (rules read either). Added nx-z0vm4 alongside `tool_use_fail` /
 * `permission_request`.
 */
export interface HookFailureEvent {
  event: "hook_failure";
  session_id?: string;
  project?: string;
  handler?: string;
  hook_name?: string;
  error?: string;
  error_message?: string;
  exit_code?: number;
  stderr?: string;
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
  | DeployStatusEvent
  | ToolUseFailEvent
  | PermissionRequestEvent
  | HookFailureEvent
  | ToolUseEndEvent
  | UserPromptEvent;

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
  // Notification-trigger events (add-hooks-notification-triggers, nx-z0vm4).
  // These have rules in `notifications/hook-rules.ts` but were never in this
  // set, so `isSocketEvent` rejected them and the socket dropped every one as
  // "unrecognised JSON" — the feature was dead in production since 2026-04-27.
  "tool_use_fail",
  "permission_request",
  "hook_failure",
  // Second recurrence of the same class (nx-9qsmb.4, 2026-07-17): a live
  // `journalctl --user -u nexus-agent` audit found `cc/scripts/hooks/
  // telemetry.sh`'s `nx_send` call sites emit far more `event_type` values
  // than this set ever allowed — every one below was confirmed either via a
  // direct `json_event ... "<type>" ...` + adjacent `nx_send` pair, or via
  // `SIMPLE_EVENTS["<type>"]` reaching the generic dispatch's `nx_send` at
  // telemetry.sh's `_se_event` site. Each was silently dropped as
  // "unrecognised JSON" exactly like the nx-z0vm4 set above — `user_prompt`
  // and `instructions_loaded` were caught live in the journal during this
  // audit. Adding a string here is necessary but NOT sufficient for an event
  // to do anything useful: `dispatcher.ts`'s `dispatchEventInner` switch has
  // no `case` for most of these (they now hit the `default: "unknown event
  // type"` warn branch instead of "unrecognised JSON" at the transport layer
  // — visible and diagnosable, but still not wired to real handling). Wiring
  // real per-type handling (or routing more of them through
  // `processHookEvent`, which today only fires from `session_start`/
  // `session_stop`/`session_heartbeat`/`notification`/`agent_spawn`) is
  // tracked separately, not folded into this allowlist fix.
  "tool_use_end",
  "command_start",
  "command_metadata",
  "agent_return",
  "user_prompt",
  "teammate_idle",
  "task_completed",
  "instructions_loaded",
  "config_change",
  "worktree_create",
  "worktree_remove",
  "session_terminate",
  "pre_compact",
  "post_compact",
  "command_end",
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
