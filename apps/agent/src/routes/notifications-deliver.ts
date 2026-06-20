/**
 * POST /notifications/deliver — receive a forwarded notification on the TARGET
 * agent (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * The originating agent resolved the live console to THIS machine and POSTed the
 * notification here. The handler:
 *
 *  - requires the `x-nexus-secret` header (401 missing / 403 mismatch) — this is
 *    the new agent-to-agent forward surface; unlike the dashboard-client routes
 *    (whose soft header gate was dropped by `drop-attach-secret-gate`), the
 *    deliver hop is secret-authed per the cross-machine-delivery spec.
 *  - validates the forwarded payload (400 on bad shape).
 *  - emits `NotificationFired` on the LOCAL lifecycle bus so this Mac renders
 *    the banner/TTS via the existing render path.
 *
 * Loop guard: this endpoint NEVER re-routes or re-forwards. It renders locally
 * only — the forward chain is exactly one hop.
 */

import { createLogger } from "@nexus/core/node";
import { lifecycleBus } from "../services/lifecycle-bus";

const log = createLogger("agent:routes:notifications-deliver");

/** Env name for the shared agent secret used on the deliver hop. */
const SECRET_ENV = "NEXUS_ATTACH_SECRET";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The minimal forwarded payload shape the deliver endpoint accepts. */
interface DeliverBody {
  id: string;
  title: string;
  body: string;
  channel: string;
  project?: string;
  items?: string[];
  logPath?: string;
  sessionName?: string;
  sessionId?: string;
}

function isValidDeliverBody(b: unknown): b is DeliverBody {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (typeof o.title !== "string") return false;
  if (typeof o.body !== "string") return false;
  if (typeof o.channel !== "string" || o.channel.length === 0) return false;
  if (o.project !== undefined && typeof o.project !== "string") return false;
  if (o.items !== undefined && !Array.isArray(o.items)) return false;
  if (o.logPath !== undefined && typeof o.logPath !== "string") return false;
  if (o.sessionName !== undefined && typeof o.sessionName !== "string") return false;
  if (o.sessionId !== undefined && typeof o.sessionId !== "string") return false;
  return true;
}

export async function handleNotificationDeliver(
  request: Request,
): Promise<Response> {
  // Secret gate (agent-to-agent forward surface).
  const expected = process.env[SECRET_ENV];
  const provided = request.headers.get("x-nexus-secret");
  if (!provided) {
    return jsonResponse({ error: "missing x-nexus-secret" }, 401);
  }
  if (!expected || provided !== expected) {
    return jsonResponse({ error: "invalid x-nexus-secret" }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (!isValidDeliverBody(body)) {
    return jsonResponse({ error: "invalid notification shape" }, 400);
  }

  // Render locally — emit NotificationFired on the LOCAL bus. NEVER re-forward
  // (loop guard): this path has no resolveLiveConsole / forwardOrLocal call.
  lifecycleBus.emit("NotificationFired", {
    id: body.id,
    title: body.title,
    body: body.body,
    channel: body.channel,
    project: body.project,
    message: body.body, // back-compat alias
    items: body.items,
    logPath: body.logPath,
    sessionName: body.sessionName,
    sessionId: body.sessionId,
  });

  log.info(
    { id: body.id, channel: body.channel },
    "notifications/deliver: forwarded notification rendered locally",
  );
  return jsonResponse({ ok: true }, 202);
}
