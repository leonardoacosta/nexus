/**
 * Hook event → notification rules. Curated routing policy mirrored from
 * `~/.claude/scripts/hooks/telemetry.sh` (see "Event destination routing"
 * section, curated 2026-04-24). Five v1 rules:
 *
 *   tool_use_fail      → desktop                (level 50, error)
 *   permission_request → desktop + tts          (level 40, friction signal)
 *   hook_failure       → desktop                (level 50, error)
 *   session_stop crash → desktop                (when crash_flag === true OR
 *                                                stop_reason ∈ {error,api_error,
 *                                                crash,timeout,oom})
 *   session_summary    → desktop digest         (when cost_usd >= 0.50)
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
import type { NotificationChannel, NotificationPriority } from "@nexus/core";

/**
 * Cost threshold (USD) above which a `session_summary` event triggers the
 * digest desktop notification. Exported for tests.
 */
export const COST_DIGEST_THRESHOLD_USD = 0.5;

/** Stop reasons that count as a crash even when `crash_flag` is unset. */
const CRASH_STOP_REASONS = new Set([
  "error",
  "api_error",
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

function readErrorMessage(payload: HookEventPayload): string {
  return payload.error_message ?? payload.error ?? "";
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
  const title = `permission requested: ${tool}`;
  const body = prefixBody(project, `permission requested for ${tool}`);

  return [
    { channel: "desktop", title, body, project, priority: "normal" },
    { channel: "tts", title, body, project, priority: "normal" },
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
  const title = `session crashed`;
  const body = prefixBody(project, `session stopped with ${reason}`);

  return [
    { channel: "desktop", title, body, project, priority: "high" },
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
 * `routes/hooks.ts`); values are pure rule functions. Tests assert exactly
 * five entries — adding a sixth is a deliberate change that requires a spec
 * update.
 */
export const hookRules: Record<string, HookRule> = {
  tool_use_fail: toolUseFailRule,
  permission_request: permissionRequestRule,
  hook_failure: hookFailureRule,
  session_stop: sessionStopRule,
  session_summary: sessionSummaryRule,
};
