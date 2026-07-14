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
import { sessionContextPatchInput, modelFamilyLetter } from "@nexus/core";
import type { SessionContextResponse } from "@nexus/core";

import { withCors } from "../server-origin";
import { getSessionByCcSessionId } from "../db/sessions";

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
 *
 * `model` is looked up fresh from `sessions.model` on every call (not cached
 * alongside the in-memory context-window entry) via `getSessionByCcSessionId`,
 * then mapped to the shared single-letter family tag via `modelFamilyLetter` —
 * the same derivation `GET /statusline` already uses. When `db` is omitted, or
 * `getSessionByCcSessionId` finds no row, or the row's `model` is `null`, this
 * fails open to `model: null` rather than throwing or altering the
 * fresh/stale/unknown-session status codes above.
 *
 * Fixed (fix-cc-session-id-bridge, nx-22xz8): this route's `id` path param is
 * CC's own raw hook session id (universe 2 — the same value context-guard.ts
 * and cc-tmux send), NOT nx's internal `sessions.id` primary key (universe 1).
 * The lookup previously called `getSessionById(db, id)`, which queries the
 * primary key — a category mismatch that meant `model` never resolved for any
 * session whose row was created via the file-watcher or HTTP session-start
 * paths (both mint their own internal id, distinct from CC's real session id).
 * The in-memory `store` Map above is unaffected — both PATCH and GET already
 * key it consistently by the same universe-2 id.
 */
export async function handleGetSessionContext(
  _request: Request,
  id: string,
  db?: Db,
): Promise<Response> {
  const entry = store.get(id);
  if (!entry || Date.now() - entry.updatedAt >= CACHE_TTL_MS) {
    return jsonResponse({ error: "no context data for session" }, 404);
  }
  let model: string | null = null;
  if (db) {
    const row = await getSessionByCcSessionId(db, id);
    model = modelFamilyLetter({ id: row?.model ?? undefined }) ?? null;
  }
  const body: SessionContextResponse = {
    sessionId: id,
    usedPercentage: entry.usedPercentage,
    contextWindowSize: entry.contextWindowSize,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    model,
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
 * sibling dispatcher signature convention and is used to derive the `model`
 * field on GET (see `handleGetSessionContext`) — the in-memory context-window
 * store itself is still not Postgres-backed.
 *
 * MUST be dispatched BEFORE the catch-all `GET /sessions/:id` route in
 * `server-request-handler.ts`, whose `/^\/sessions\/(.+)$/` pattern would
 * otherwise swallow `/sessions/:id/context`.
 */
export function tryHandleSessionContextRoute(
  request: Request,
  url: URL,
  db?: Db,
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
    return wrap(handleGetSessionContext(request, id, db), "GET");
  }
  if (request.method === "PATCH") {
    return wrap(handlePatchSessionContext(request, id), "PATCH");
  }

  return null;
}
