/**
 * In-memory, session-id-keyed context-window store + GET/PATCH routes.
 *
 * Backs the session-keyed context-window API: nexus-statusline pushes its
 * resolved context reading here on every render (fire-and-forget PATCH), and
 * any caller reachable at the agent's bind address can query it (GET).
 *
 * Ephemeral by design — mirrors `routes/elevenlabs-voices.ts`'s in-memory
 * `Map`-with-TTL cache rather than a Postgres table: this is
 * per-render-frequency state with no historical-query need, so a durable row
 * would be pure write amplification. An agent restart drops the map; the next
 * statusline render repopulates the entry within seconds via the same push.
 *
 * Endpoints (no per-request auth gate; reach bounded at the bind layer —
 * loopback + Tailscale only):
 *   GET   /sessions/:id/context   — fresh entry, or 404 when absent/stale
 *   PATCH /sessions/:id/context   — upsert; 204 on success, 400 on invalid body
 *
 * Spec: openspec/changes/add-session-context-api/
 */

import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import { sessionContextPatchInput } from "@nexus/core";
import type { SessionContextResponse } from "@nexus/core";

import { withCors } from "../server-origin";

interface ContextEntry {
  usedPercentage: number;
  contextWindowSize: number | null;
  updatedAt: number; // epoch ms
}

/**
 * Entries older than this are treated as absent — matches `context-guard.ts`'s
 * `CTX_FRESH_WINDOW_SECS` freshness convention (600s).
 */
const CACHE_TTL_MS = 600 * 1_000; // 600s

const store = new Map<string, ContextEntry>();

/** Reset the store (testing only). */
export function resetSessionContextStore(): void {
  store.clear();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /sessions/:id/context — return the fresh entry for `id`, or
 * `404 {"error": "no context data for session"}` when absent or stale.
 */
export function handleGetSessionContext(_request: Request, id: string): Response {
  const entry = store.get(id);
  if (!entry || Date.now() - entry.updatedAt >= CACHE_TTL_MS) {
    return jsonResponse({ error: "no context data for session" }, 404);
  }
  const body: SessionContextResponse = {
    sessionId: id,
    usedPercentage: entry.usedPercentage,
    contextWindowSize: entry.contextWindowSize,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };
  return jsonResponse(body);
}

/**
 * PATCH /sessions/:id/context — validate the body against
 * `sessionContextPatchInput`, then write/overwrite the entry for `id` with the
 * current timestamp. `204` on success, `400` on an invalid body (store left
 * unchanged).
 */
export async function handlePatchSessionContext(
  request: Request,
  id: string,
): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const parsed = sessionContextPatchInput.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(
      { error: "invalid input", detail: parsed.error.issues },
      400,
    );
  }

  store.set(id, {
    usedPercentage: parsed.data.usedPercentage,
    contextWindowSize: parsed.data.contextWindowSize ?? null,
    updatedAt: Date.now(),
  });
  return new Response(null, { status: 204 });
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Match and handle a session-context route.
 *
 * Parses the `:id` path segment from `/sessions/:id/context` and delegates to
 * the handler for the method. Returns a Response when the URL matches, or
 * `null` when it does not (callers fall through). The `db?` param mirrors the
 * sibling dispatcher signature convention but is unused — this store is
 * in-memory, not Postgres.
 *
 * MUST be dispatched BEFORE the catch-all `GET /sessions/:id` route in
 * `server-request-handler.ts`, whose `/^\/sessions\/(.+)$/` pattern would
 * otherwise swallow `/sessions/:id/context`.
 */
export function tryHandleSessionContextRoute(
  request: Request,
  url: URL,
  _db?: Db,
): Response | Promise<Response> | null {
  // ["", "sessions", ":id", "context"]
  const segments = url.pathname.split("/");
  if (
    segments.length !== 4 ||
    segments[1] !== "sessions" ||
    segments[3] !== "context"
  ) {
    return null;
  }
  const id = segments[2];
  if (!id) return null;

  const route = `/sessions/${id}/context`;
  const wrap = (
    p: Response | Promise<Response>,
    method: string,
  ): Promise<Response> =>
    Promise.resolve(p)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error({ route, method, err }, "route handler failed");
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

  if (request.method === "GET") {
    return wrap(handleGetSessionContext(request, id), "GET");
  }
  if (request.method === "PATCH") {
    return wrap(handlePatchSessionContext(request, id), "PATCH");
  }

  return null;
}
