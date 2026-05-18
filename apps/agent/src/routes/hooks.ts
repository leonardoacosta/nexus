/**
 * POST /hooks — receive CC session events via HTTP.
 *
 * Persists every recognized event to the `session_events` table and updates
 * the `sessions` table for lifecycle events (`session_start`, `session_stop`,
 * `stop_failure`, `session_summary`).
 *
 * Errors during DB writes are logged but never surface to the caller — cc
 * events are fire-and-forget and a transient DB hiccup must not break the
 * upstream hook pipeline.
 */

import type { Db } from "@nexus/db";
import { sessions } from "@nexus/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

import {
  upsertSession,
  updateSessionStatus,
  getSessionById,
} from "../db/sessions";
import { resolveGitOrigin } from "../services/git-project";
import { appendSessionEvent } from "../db/events";
import { computeCostUsd } from "../services/cost-calculator";
import { lifecycleBus } from "../services/lifecycle-bus";
import { hookEventThrottle } from "../services/hook-event-throttle";
import { inspectAndEmitDrift } from "../services/schema-drift";
import { evaluateAndDispatch } from "../notifications/hook-trigger";
import { getNotificationManager } from "./notifications";

const log = createLogger("agent:routes:hooks");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  tmux_target?: string;
  machine?: string;
  tool_counts?: Record<string, number>;
  failure_count?: number;
  /** post_compact: number of compactions observed by the session so far */
  compaction_count?: number;
  agent_spawns?: number;
  duration_ms?: number;
  reason?: string;
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
   * `stop_reason` of error/api_error/crash/timeout/oom counts as a crash —
   * see `notifications/hook-rules.ts`.
   */
  crash_flag?: boolean;
}

const RECOGNIZED_EVENTS = new Set([
  // Legacy lifecycle (pre-existing)
  "session_start",
  "session_stop",
  "stop_failure",
  "stop_success",
  "session_summary",
  "session_heartbeat",
  "diagnostic_ping",
  // Lifecycle expansion
  "session_terminate",
  "post_compact",
  "pre_compact",
  "heartbeat",
  // Agents
  "agent_spawn",
  "agent_telemetry",
  "agent_complete",
  // Tools
  "tool_use_end",
  "tool_use_fail",
  // Commands
  "command_start",
  "command_end",
  "user_prompt",
  // Operational
  "permission_request",
  "teammate_idle",
  "task_completed",
  "instructions_loaded",
  "config_change",
  "worktree_create",
  "worktree_remove",
  "notification",
  "hook_failure",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Check whether the session id is known to the agent.
 *
 * Prior to fix-agent-cc-session-tracking we used to INSERT a minimal stub
 * for any non-`session_start` event on an unknown id so the FK on
 * `session_events.session_id` was satisfied. That path is what produced
 * the ~4k stub-session backlog. The current contract (per the spec):
 *   - session_start  → creates the row via `handleSessionStart` (below)
 *   - anything else  → dropped with 204 if the row doesn't exist
 */
async function sessionExists(db: Db, sessionId: string): Promise<boolean> {
  const existing = await getSessionById(db, sessionId);
  return existing !== null;
}

async function handleSessionStart(
  db: Db,
  sessionId: string,
  payload: HookEventPayload,
): Promise<void> {
  const now = new Date();
  await upsertSession(db, {
    id: sessionId,
    pid: payload.pid ?? 0,
    project: undefined,
    projectId: null,
    machine: payload.machine ?? "local",
    cwd: payload.cwd ?? "",
    branch: payload.branch ?? null,
    startedAt: now,
    lastHeartbeat: now,
    endedAt: null,
    status: "active",
    spec: null,
    command: null,
    agent: null,
    tmuxSession: null,
    ccSessionId: payload.cc_session_id ?? null,
    tmuxTarget: payload.tmux_target ?? null,
    rateLimitUtilization: null,
    rateLimitType: null,
    totalCostUsd: null,
    model: payload.model ?? null,
    credentialId: null,
    credentialFingerprint: null,
    sessionType: "ad_hoc",
  });

  // Resolve git origin from cwd. Fire-and-forget: never block session start
  // on a slow `git` exec, and never fail when the cwd isn't a git checkout.
  const cwd = payload.cwd;
  if (cwd) {
    const origin = await resolveGitOrigin(cwd);
    if (origin) {
      await db
        .update(sessions)
        .set({
          gitProvider: origin.provider,
          gitOwnerRepo: origin.ownerRepo,
        })
        .where(eq(sessions.id, sessionId));
    }
  }
}

async function handleSessionSummary(
  db: Db,
  sessionId: string,
  payload: HookEventPayload,
): Promise<void> {
  let cost: number | null = null;
  if (typeof payload.cost_usd === "number") {
    cost = payload.cost_usd;
  } else if (
    typeof payload.input_tokens === "number" ||
    typeof payload.output_tokens === "number" ||
    typeof payload.cache_read_input_tokens === "number" ||
    typeof payload.cache_creation_input_tokens === "number"
  ) {
    cost = computeCostUsd(payload.model ?? null, {
      input: payload.input_tokens,
      output: payload.output_tokens,
      cacheRead: payload.cache_read_input_tokens,
      cacheCreation: payload.cache_creation_input_tokens,
    });
  }

  if (cost === null) return;

  await db
    .update(sessions)
    .set({ totalCostUsd: cost, lastActivity: new Date() })
    .where(eq(sessions.id, sessionId));
}

async function handleStopFailure(db: Db, sessionId: string): Promise<void> {
  const now = new Date();
  await db
    .update(sessions)
    .set({ status: "errored", endedAt: now, lastActivity: now })
    .where(eq(sessions.id, sessionId));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleHooks(
  db: Db,
  request: Request,
): Promise<Response> {
  let payload: HookEventPayload;
  try {
    payload = (await request.json()) as HookEventPayload;
  } catch {
    return jsonResponse(400, { status: "error", message: "invalid JSON" });
  }

  const eventName = payload.hook_event_name ?? payload.event ?? "unknown";
  const sessionId = payload.session_id;

  log.info({ event: eventName, sessionId }, "hook event received");

  // Schema-drift detector — fire-and-forget, runs BEFORE the
  // RECOGNIZED_EVENTS gate so unknown events still emit drift telemetry.
  // Errors are swallowed by the detector itself.
  void inspectAndEmitDrift(db, eventName, payload);

  if (!RECOGNIZED_EVENTS.has(eventName)) {
    return jsonResponse(200, {
      status: "ok",
      message: `unknown event: ${eventName}`,
    });
  }

  if (!sessionId) {
    log.warn({ event: eventName }, "event missing session_id — skipping persistence");
    return jsonResponse(200, {
      status: "ok",
      message: `${eventName} acknowledged (no session_id)`,
    });
  }

  let insertedEventId: number | null = null;
  try {
    // 1. Ensure parent session row exists. session_start does its own upsert
    //    with full metadata; everything else REQUIRES a pre-existing row
    //    (created either by an earlier session_start hook or by the
    //    process-watcher reconciler). Per fix-agent-cc-session-tracking the
    //    handler MUST NOT synthesize stub rows from telemetry pings — those
    //    produced the ~4k empty-row backlog. Orphans are dropped with 204.
    if (eventName === "session_start") {
      await handleSessionStart(db, sessionId, payload);
    } else {
      const exists = await sessionExists(db, sessionId);
      if (!exists) {
        log.info({ sessionId }, "hooks: orphan event sessionId=" + sessionId);
        return new Response(null, { status: 204 });
      }
    }

    // 2. Append the event row (full payload preserved as JSON metadata).
    insertedEventId = await appendSessionEvent(db, {
      sessionId,
      eventType: eventName,
      timestamp: new Date(),
      metadata: JSON.stringify(payload),
    });

    // 3. Lifecycle side effects on the sessions table.
    switch (eventName) {
      case "session_summary":
        await handleSessionSummary(db, sessionId, payload);
        break;
      case "session_stop":
      case "stop_success":
      case "session_terminate":
        await updateSessionStatus(db, sessionId, "ended");
        break;
      case "stop_failure":
        await handleStopFailure(db, sessionId);
        break;
      // session_start: handled above; session_heartbeat / diagnostic_ping:
      // no further sessions-table mutation beyond the ensure step.
      default:
        break;
    }
  } catch (err) {
    // Never surface DB errors — cc events are fire-and-forget.
    log.error(
      { err, event: eventName, sessionId },
      "failed to persist hook event",
    );
    return jsonResponse(200, {
      status: "ok",
      message: `${eventName} acknowledged (persistence error logged)`,
    });
  }

  // 4. Fan out to the lifecycle bus so SSE subscribers (dashboards, CLI)
  //    can react in real time. Guarded on `insertedEventId !== null` so
  //    we never broadcast an id that resolves to no row. High-frequency
  //    types (`tool_use_start`/`tool_use_end`) flow through the throttle;
  //    everything else emits immediately.
  if (insertedEventId !== null) {
    const hookPayload = {
      eventType: eventName,
      sessionId,
      ...(payload.project !== undefined ? { project: payload.project } : {}),
      eventId: insertedEventId,
    };
    const { throttled } = hookEventThrottle.enqueue(hookPayload);
    if (!throttled) {
      lifecycleBus.emit("HookEventReceived", hookPayload);
    }
  }

  // 5. Evaluate notification rules and dispatch via the existing
  //    NotificationManager pipeline (Wave 3, add-hooks-notification-triggers).
  //    The trigger MUST NOT cause this handler to return non-200 — cc events
  //    are fire-and-forget. evaluateAndDispatch is no-throw by contract, but
  //    the try/catch is non-negotiable belt-and-braces.
  try {
    const manager = getNotificationManager();
    if (manager) {
      await evaluateAndDispatch(db, manager, eventName, payload);
    }
  } catch (err) {
    log.warn(
      { err, event: eventName, sessionId },
      "evaluateAndDispatch threw — hook still 200",
    );
  }

  return jsonResponse(200, {
    status: "ok",
    message: `${eventName} acknowledged`,
    ...(insertedEventId !== null ? { event_id: insertedEventId } : {}),
  });
}
