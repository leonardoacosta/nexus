/**
 * Hook event → notification rules. Curated routing policy mirrored from
 * `~/.claude/scripts/hooks/telemetry.sh` (see "Event destination routing"
 * section, curated 2026-04-24). Six rules:
 *
 *   tool_use_fail      → desktop                (level 50, error)
 *   permission_request → desktop + tts          (level 40, friction signal)
 *   hook_failure       → desktop                (level 50, error)
 *   session_stop crash → desktop                (when crash_flag === true OR
 *                                                stop_reason ∈ {error,crash,
 *                                                timeout,oom})
 *   session_summary    → desktop digest         (when cost_usd >= 0.50)
 *   api_error           → desktop + tts          (stop_reason === "api_error";
 *                                                routed via the synthetic
 *                                                `api_error` eventType key —
 *                                                see apiErrorRule / nx-7tfim)
 *
 * Slack channel was removed by `remove-slack-channel` (spine-migration); the
 * desktop channel carries the same error signal via UNNotificationCenter.
 *
 * Rules are pure functions: they take the hook event payload and return a
 * `NotificationDraft[]` (one entry per channel) or `null` when the predicate
 * fails. They MUST NOT touch the database, the lifecycle bus, or external
 * clients. Suppression and `notification_settings` filtering live in the
 * orchestrator (`hook-trigger.ts`).
 *
 * Field-name policy
 * ─────────────────
 * Wave 1 of the hooks taxonomy expansion typed inbound payload fields with
 * cc-side names (`tool`, `error`, `handler`). The notification spec uses the
 * names `tool_name`, `error_message`, `hook_name`. Rules read both via the
 * `??` fallback so either upstream wire shape works. The aliases are also
 * declared as optional fields on `HookEventPayload` (see `routes/hooks-types.ts`).
 */

import type { HookEventPayload } from "../routes/hooks-types";
import type {
  NotificationChannel,
  NotificationPriority,
  NotificationSeverity,
} from "@nexus/core";

/**
 * Cost threshold (USD) above which a `session_summary` event triggers the
 * digest desktop notification. Exported for tests.
 */
export const COST_DIGEST_THRESHOLD_USD = 0.5;

/**
 * Stop reasons that count as a crash even when `crash_flag` is unset.
 *
 * `api_error` was REMOVED here (add-api-error-notification, nx-kaxig) and ceded
 * to `apiErrorRule`, which owns the desktop+tts error classification for
 * `stop_reason === "api_error"` stops. `dispatchStopNotification`
 * (`services/socket-server/dispatcher.ts`) routes those stops to the
 * synthetic `api_error` eventType key instead of `session_stop` — that
 * routing was missing until nx-7tfim, so api_error crash stops previously
 * produced zero notifications despite this exclusion. `sessionStopRule`
 * retains `error`, `crash`, `timeout`, `oom`.
 */
const CRASH_STOP_REASONS = new Set([
  "error",
  "crash",
  "timeout",
  "oom",
]);

/**
 * Notification draft produced by a rule. Mirrors the shape consumed by
 * `NotificationManager.send()` minus the orchestrator-managed fields
 * (`status`, `sentAt`). The trigger orchestrator generates the `id`,
 * stamps `createdAt`, fills `agentId: null`, and forwards everything to
 * the manager.
 */
export interface NotificationDraft {
  channel: NotificationChannel;
  title: string;
  body: string;
  project: string | null;
  priority: NotificationPriority;
  /**
   * CC custom session name (the `/rename` title) carried transport-only from
   * the hook payload's snake_case `session_name` (nx-20caf). camelCase here to
   * match `logPath` / `audioBase64` on the lifecycle/wire types. Undefined when
   * the upstream payload had no custom title (or an empty string) — consumers
   * must degrade gracefully to today's session-less behavior.
   */
  sessionName?: string;
  /**
   * CC session id (transcript uuid) carried transport-only from the hook
   * payload's `session_id` (mx-7i4k). Surfaced downstream as `userInfo.sessionId`
   * on the iOS alert push so a banner tap deep-links to the originating
   * session's detail view. Undefined for non-session events.
   */
  sessionId?: string;
  /**
   * Dashboard-facing severity (add-api-error-notification, nx-06bbb).
   * Optional because most rules leave it unset — `manager.send()` defaults a
   * missing severity to `"info"`. The `apiErrorRule` sets `"error"` so the
   * Swift dashboard surfaces api-error rows with error-level urgency. The
   * trigger orchestrator (`hook-trigger.ts`) threads this onto the
   * `manager.send()` notification arg, which already accepts an optional
   * `severity` field.
   */
  severity?: NotificationSeverity;
}

/**
 * A rule is a pure function: given a payload, return one draft per channel,
 * or `null` when the predicate fails (e.g. session_summary below threshold).
 */
export type HookRule = (payload: HookEventPayload) => NotificationDraft[] | null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function projectOf(payload: HookEventPayload): string | null {
  return payload.project ?? null;
}

/** Project-prefixed body: "<project>: <message>" when project is present. */
function prefixBody(project: string | null, message: string): string {
  if (project && project.length > 0) {
    return `${project}: ${message}`;
  }
  return message;
}

function readToolName(payload: HookEventPayload): string {
  return payload.tool_name ?? payload.tool ?? "unknown";
}

/**
 * Read the CC custom session name (nx-20caf). Snake_case `session_name` in,
 * camelCase out. An absent or empty-string title yields `undefined` so the
 * field is omitted from the draft and downstream wire (graceful degrade).
 */
function readSessionName(payload: HookEventPayload): string | undefined {
  const name = payload.session_name;
  return name && name.length > 0 ? name : undefined;
}

/**
 * Read the CC session id (mx-7i4k). Prefer the explicit `cc_session_id`, fall
 * back to `session_id`. Empty/absent yields `undefined` so the field is omitted
 * from the draft and downstream wire (graceful degrade — non-session events).
 */
function readSessionId(payload: HookEventPayload): string | undefined {
  const id = payload.cc_session_id ?? payload.session_id;
  return id && id.length > 0 ? id : undefined;
}

function readErrorMessage(payload: HookEventPayload): string {
  return payload.error_message ?? payload.error ?? "";
}

/**
 * Read the `session_stop` crash error text (nx-f060f). Mirrors
 * `readErrorMessage` but reads the dedicated `error_details` field carried by
 * the CC Stop hook. Empty/absent yields `""` so the rule degrades to the
 * generic "session stopped with <reason>" body.
 */
function readErrorDetails(payload: HookEventPayload): string {
  return payload.error_details ?? "";
}

/**
 * Per-reason title for a crash stop (nx-f060f). `api_error` reads as "api
 * error" (the most common rate-limit / overload case the user wants to spot at
 * a glance); every other reason falls back to the generic "crashed".
 */
function crashTitle(reason: string): string {
  switch (reason) {
    case "api_error":
      return "session: api error";
    case "timeout":
      return "session: timed out";
    case "oom":
      return "session: out of memory";
    default:
      return "session crashed";
  }
}

function readHookName(payload: HookEventPayload): string {
  return payload.hook_name ?? payload.handler ?? "unknown";
}

function isCrashStop(payload: HookEventPayload): boolean {
  if (payload.crash_flag === true) return true;
  if (payload.stop_reason && CRASH_STOP_REASONS.has(payload.stop_reason)) {
    return true;
  }
  return false;
}

/**
 * Predicate for the api-error rule (add-api-error-notification, nx-06bbb).
 * Fires when the CC Stop hook reports `stop_reason === "api_error"`.
 * `sessionStopRule` no longer claims this reason (nx-kaxig).
 *
 * A second payload shape — a mid-session emit carrying `reason: "api_error"`,
 * sourced from the token-stream tail-watcher's `onApiError` callback —
 * previously fired this predicate too. `read-cc-telemetry-from-influxdb`
 * deleted the token-stream module, and nothing in the dispatcher ever read
 * `reason` off the `"notification"` socket event to reach this rule, so that
 * shape was dead code with no live producer. Removed nx-7tfim.
 */
function isApiError(payload: HookEventPayload): boolean {
  return payload.stop_reason === "api_error";
}

// ─── Rule bodies ─────────────────────────────────────────────────────────────

const toolUseFailRule: HookRule = (payload) => {
  const project = projectOf(payload);
  const tool = readToolName(payload);
  const error = readErrorMessage(payload);
  const title = `tool failed: ${tool}`;
  const message = error
    ? `${tool} failed: ${error}`
    : `${tool} failed`;
  const body = prefixBody(project, message);

  return [
    { channel: "desktop", title, body, project, priority: "high" },
  ];
};

const permissionRequestRule: HookRule = (payload) => {
  const project = projectOf(payload);
  const tool = readToolName(payload);
  const sessionName = readSessionName(payload);
  const sessionId = readSessionId(payload);
  const title = `permission requested: ${tool}`;
  const body = prefixBody(project, `permission requested for ${tool}`);

  // sessionName is transport-only: the primary spoken path lives in
  // telemetry.sh (nx-20caf Path A). The agent body stays minimal and safe —
  // we only thread the name so the lifecycle emit + Swift consumer can read it.
  // sessionId (mx-7i4k) rides alongside so the iOS banner tap deep-links to the
  // originating session's detail view.
  return [
    { channel: "desktop", title, body, project, priority: "normal", sessionName, sessionId },
    { channel: "tts", title, body, project, priority: "normal", sessionName, sessionId },
  ];
};

const hookFailureRule: HookRule = (payload) => {
  const project = projectOf(payload);
  const hookName = readHookName(payload);
  const error = readErrorMessage(payload);
  const title = `hook failed: ${hookName}`;
  const message = error
    ? `hook ${hookName} failed: ${error}`
    : `hook ${hookName} failed`;
  const body = prefixBody(project, message);

  return [
    { channel: "desktop", title, body, project, priority: "high" },
  ];
};

const sessionStopRule: HookRule = (payload) => {
  if (!isCrashStop(payload)) return null;

  const project = projectOf(payload);
  const reason = payload.stop_reason ?? "crash";
  const details = readErrorDetails(payload);
  const title = crashTitle(reason);
  // Per-reason classified body: include the captured error text when present
  // (e.g. "api_error: API Error: 529 Overloaded"), else the generic form.
  const message = details
    ? `${reason}: ${details}`
    : `session stopped with ${reason}`;
  const body = prefixBody(project, message);

  return [
    { channel: "desktop", title, body, project, priority: "high" },
  ];
};

/**
 * API-error rule (add-api-error-notification, nx-06bbb).
 *
 * Emits BOTH a desktop and a tts draft at `priority: "high"` and
 * `severity: "error"`, with a project-prefixed body `api error: <text>`.
 * Fires for `stop_reason === "api_error"` crash stops — see `isApiError`.
 * Registered in the rule registry under the synthetic key `api_error`;
 * `dispatchStopNotification` (`services/socket-server/dispatcher.ts`) routes
 * a session stop whose `stop_reason` is `"api_error"` to this key instead of
 * `"session_stop"` (nx-7tfim — this routing was missing until now, so
 * api_error crash stops previously produced no notification at all). The
 * trigger orchestrator keys suppression on `api_error:<session_id>` so a
 * multi-minute 529 outage alerts once per session (nx-avasg).
 *
 * A mid-session emit path (`reason: "api_error"`, sourced from a token-stream
 * tail-watcher's `onApiError` callback) previously fed this rule too, but the
 * token-stream module was deleted by `read-cc-telemetry-from-influxdb` and
 * nothing replaced it as a producer — removed nx-7tfim. See `isApiError`.
 */
const apiErrorRule: HookRule = (payload) => {
  if (!isApiError(payload)) return null;

  const project = projectOf(payload);
  // Prefer the dedicated crash-stop `error_details`; fall back to the
  // `error_message`/`error` aliases the mid-session emit maps the api-error
  // text onto. Empty string yields the bare "api error" body.
  const text = readErrorDetails(payload) || readErrorMessage(payload);
  const sessionId = readSessionId(payload);
  const title = "session: api error";
  const message = text ? `api error: ${text}` : "api error";
  const body = prefixBody(project, message);

  const common = {
    title,
    body,
    project,
    priority: "high" as NotificationPriority,
    severity: "error" as NotificationSeverity,
    sessionId,
  };

  return [
    { channel: "desktop", ...common },
    { channel: "tts", ...common },
  ];
};

const sessionSummaryRule: HookRule = (payload) => {
  const cost = payload.cost_usd;
  if (typeof cost !== "number" || cost < COST_DIGEST_THRESHOLD_USD) {
    return null;
  }

  const project = projectOf(payload);
  const title = `session summary`;
  const body = prefixBody(project, `session cost $${cost.toFixed(2)}`);

  return [{ channel: "desktop", title, body, project, priority: "normal" }];
};

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Static rule registry. Keys are event types (matching `RECOGNIZED_EVENTS` in
 * `routes/hooks.ts`); values are pure rule functions. The `api_error` key is a
 * synthetic event type (add-api-error-notification, nx-06bbb): it is not a CC
 * hook name but a routing key the dispatcher/tail-watcher use to reach
 * `apiErrorRule` via `evaluateAndDispatch(..., "api_error", payload)`. Tests
 * assert exactly six entries — adding a seventh is a deliberate change that
 * requires a spec update.
 */
export const hookRules: Record<string, HookRule> = {
  tool_use_fail: toolUseFailRule,
  permission_request: permissionRequestRule,
  hook_failure: hookFailureRule,
  session_stop: sessionStopRule,
  session_summary: sessionSummaryRule,
  api_error: apiErrorRule,
};
