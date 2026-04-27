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
import { appendSessionEvent } from "../db/events";
import { computeCostUsd } from "../services/cost-calculator";

const log = createLogger("agent:routes:hooks");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookEventPayload {
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
  /** tool_use_fail: stderr/error description */
  error?: string;
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
  exit_code?: number;
  stderr?: string;
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
 * Ensure a session row exists for the given id. For non-`session_start`
 * events on unknown ids we INSERT a minimal stub so the FK on
 * `session_events.session_id` is satisfied. Idempotent.
 */
async function ensureSessionRow(
  db: Db,
  sessionId: string,
  payload: HookEventPayload,
): Promise<void> {
  const existing = await getSessionById(db, sessionId);
  if (existing) return;

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
    //    with full metadata; everything else gets a stub if missing so the
    //    FK on session_events.session_id is satisfied.
    if (eventName === "session_start") {
      await handleSessionStart(db, sessionId, payload);
    } else {
      await ensureSessionRow(db, sessionId, payload);
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

  return jsonResponse(200, {
    status: "ok",
    message: `${eventName} acknowledged`,
    ...(insertedEventId !== null ? { event_id: insertedEventId } : {}),
  });
}
