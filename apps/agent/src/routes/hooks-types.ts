/**
 * Shared types for hook event payloads.
 *
 * Extracted from `routes/hooks.ts` when the HTTP POST /hooks endpoint was
 * deleted (spec: `delete-http-hooks-endpoint`, 2026-05-18). The HTTP route
 * is gone; `HookEventPayload` lives on because the notification machinery
 * (`notifications/hook-rules.ts`, `notifications/hook-trigger.ts`) still
 * evaluates hook-shaped payloads when they arrive via other transports
 * (currently dormant; preserved for socket-side reuse).
 */

export interface HookEventPayload {
  hook_event_name?: string;
  event?: string;
  session_id?: string;
  project?: string;
  cwd?: string;
  model?: string;
  pid?: number;
  branch?: string;
  cc_session_id?: string;
  /**
   * CC custom session name — the `/rename` title persisted as `customTitle`
   * in the transcript jsonl (nx-20caf). Snake_case to match `tool_name` /
   * `hook_event_name`. Absent/empty when no custom title is set; downstream
   * the notification machinery surfaces it as the camelCase `sessionName`.
   */
  session_name?: string;
  tmux_target?: string;
  machine?: string;
  tool_counts?: Record<string, number>;
  failure_count?: number;
  /** post_compact: number of compactions observed by the session so far */
  compaction_count?: number;
  agent_spawns?: number;
  duration_ms?: number;
  stop_reason?: string;
  // session_summary token + cost fields
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;

  /** Tool execution events: tool_use_end, tool_use_fail, permission_request */
  tool?: string;
  /**
   * Alias for `tool` used by the notification trigger spec (Wave 3,
   * `add-hooks-notification-triggers`). Rules read `tool_name ?? tool` so
   * either upstream key works; cc-side telemetry currently emits `tool`.
   */
  tool_name?: string;
  /** tool_use_fail: stderr/error description */
  error?: string;
  /** Alias for `error` consumed by notification rules. */
  error_message?: string;
  /**
   * `session_stop` crash error text (nx-f060f). Free-form detail captured by
   * the CC Stop hook (e.g. "API Error: 529 Overloaded"). Read by the
   * `session_stop` notification rule to build a per-reason body, and persisted
   * to `sessions.error_details`.
   */
  error_details?: string;
  /** tool_use_fail: command line that failed */
  command?: string;

  /** Agent lifecycle: agent_spawn, agent_telemetry, agent_complete */
  agent_type?: string;
  agent_name?: string;
  parent_agent?: string;
  child_role?: string;

  /** Command lifecycle: command_start, command_end */
  run_id?: string;
  parent_run_id?: string;
  status?: string;

  /** agent_telemetry only */
  total_tokens?: number;
  tool_uses?: number;
  phase?: string;
  wave?: number;
  spec?: string;

  /** hook_failure only */
  handler?: string;
  /** Alias for `handler` consumed by notification rules (`hook_failure`). */
  hook_name?: string;
  exit_code?: number;
  stderr?: string;

  /**
   * `session_stop` crash predicate (Wave 3 notification trigger). When true,
   * the session_stop rule fires desktop+slack. Either this flag or a
   * `stop_reason` of error/crash/timeout/oom counts as a crash — see
   * `notifications/hook-rules.ts` CRASH_STOP_REASONS. `stop_reason ===
   * "api_error"` is also a crash, but routes to the separate `apiErrorRule`
   * (desktop+tts) via the dispatcher, not this flag — see
   * `services/socket-server/dispatcher.ts` `dispatchStopNotification`.
   */
  crash_flag?: boolean;
}
