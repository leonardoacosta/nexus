/**
 * POST /presence/report — the thin presence ingest endpoint
 * (openspec/changes/context-aware-routing, Phase 1).
 *
 * Any reporter (a future Mac/iOS observer, a CLI poller, or a test) pushes a
 * partial presence report; the handler validates the shape and merges it into
 * the agent-held `PresenceVector` via the presence-context singleton, which in
 * turn emits `PresenceChanged`. Phase 1 proves the rules engine end-to-end by
 * POSTing states — the real device observers land in later phases.
 *
 * Auth note: reach is constrained at the bind layer (loopback + Tailscale
 * only), same convention as the sibling notification routes — handlers do not
 * call `requireSecret` directly.
 */

import { createLogger } from "@nexus/core/node";
import {
  getPresenceContext,
  type PresenceReport,
} from "../notifications/presence-context";

const log = createLogger("agent:routes:presence-report");

/** Allowed report keys + their runtime type guards. */
const FIELD_VALIDATORS: Record<
  keyof PresenceReport,
  (v: unknown) => boolean
> = {
  macActive: (v) => typeof v === "boolean",
  macLocked: (v) => typeof v === "boolean",
  macHost: (v) => typeof v === "string",
  inMeeting: (v) => typeof v === "boolean",
  // meetingEndsAt may be an ISO string or explicit null (meeting end cleared).
  meetingEndsAt: (v) => v === null || typeof v === "string",
  isBedtime: (v) => typeof v === "boolean",
};

const ALLOWED_KEYS = Object.keys(FIELD_VALIDATORS) as (keyof PresenceReport)[];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handlePresenceReport(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "body must be a JSON object" }, 400);
  }

  const patch = body as Record<string, unknown>;
  const keys = Object.keys(patch);

  if (keys.length === 0) {
    return jsonResponse(
      { error: "empty report", detail: "at least one presence field is required" },
      400,
    );
  }

  // Allow-list + per-field type validation.
  for (const key of keys) {
    if (!(key in FIELD_VALIDATORS)) {
      return jsonResponse(
        {
          error: "unknown field",
          detail: `"${key}" is not one of: ${ALLOWED_KEYS.join(", ")}`,
        },
        400,
      );
    }
    if (!FIELD_VALIDATORS[key as keyof PresenceReport](patch[key])) {
      return jsonResponse(
        { error: "invalid field type", detail: `"${key}" has the wrong type` },
        400,
      );
    }
  }

  const report = patch as PresenceReport;
  const ctx = getPresenceContext();
  ctx.report(report, "mac");

  log.debug({ fields: keys }, "presence-report: merged report");
  return jsonResponse({ vector: ctx.vector() });
}
