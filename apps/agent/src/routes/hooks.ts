/**
 * POST /hooks — receive CC session events via HTTP.
 *
 * Split from operational.ts.
 */

import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core/node";

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
  tool_counts?: Record<string, number>;
  failure_count?: number;
  compaction_count?: number;
  agent_spawns?: number;
  duration_ms?: number;
  reason?: string;
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
    return new Response(
      JSON.stringify({ status: "error", message: "invalid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const eventName =
    payload.hook_event_name ?? payload.event ?? "unknown";

  log.info({ event: eventName, sessionId: payload.session_id }, "hook event received");

  // For now, acknowledge all hook events. The socket dispatch layer
  // handles the actual session lifecycle management.
  switch (eventName) {
    case "session_start":
    case "session_stop":
    case "stop_failure":
    case "stop_success":
    case "session_summary":
    case "session_heartbeat":
      return new Response(
        JSON.stringify({ status: "ok", message: `${eventName} acknowledged` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    default:
      return new Response(
        JSON.stringify({
          status: "ok",
          message: `unknown event: ${eventName}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
  }
}
