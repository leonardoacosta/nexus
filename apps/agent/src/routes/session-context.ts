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
  /**
   * Raw model payload captured from the statusline-ctx snapshot
   * (forward-statusline-model). Stored raw rather than pre-mapped to a
   * letter so `handleGetSessionContext` can run it through the same
   * `modelFamilyLetter` derivation it already applies to the DB-sourced
   * value below — one mapping call site, not two.
   */
  model?: { id?: string; display_name?: string };
}

/**
 * Entries older than this are treated as absent — matches `context-guard.ts`'s
 * `CTX_FRESH_WINDOW_SECS` freshness convention (600s). Exported so
 * `statusline-ctx-poller.ts` shares this exact freshness window rather than
 * re-hardcoding 600.
 */
export const CACHE_TTL_MS = 600 * 1_000; // 600s

const store = new Map<string, ContextEntry>();

/** Reset the store (testing only). */
export function resetSessionContextStore(): void {
  store.clear();
}

/** The fresh subset a read accessor hands back — usage + window, no timestamp. */
export interface FreshContextEntry {
  usedPercentage: number;
  contextWindowSize: number | null;
}

/**
 * Pure read accessor: the fresh entry for `id`, or `null` when absent or past
 * `CACHE_TTL_MS`. This is the SINGLE freshness-check implementation — both
 * `handleGetSessionContext` (GET /sessions/:id/context) and
 * `buildSessionStatus` (GET /statusline, `routes/statusline.ts`) route their
 * fresh-vs-stale decision through here, so the `Date.now() - entry.updatedAt >=
 * CACHE_TTL_MS` comparison lives in exactly one place.
 */
export function getFreshContextEntry(id: string): FreshContextEntry | null {
  const entry = store.get(id);
  if (!entry || Date.now() - entry.updatedAt >= CACHE_TTL_MS) {
    return null;
  }
  return {
    usedPercentage: entry.usedPercentage,
    contextWindowSize: entry.contextWindowSize,
  };
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
 * `model` resolution precedence (forward-statusline-model): PREFER the raw
 * model payload already captured alongside the in-memory context-window entry
 * (forwarded by `statusline-ctx-poller.ts` from CC's own per-invocation
 * `ccInput.model`, via `applyStatuslineSnapshot`) — this is the reliable path,
 * since it comes straight from CC's statusline stdin on every render. FALL
 * BACK to a fresh `sessions.model` DB lookup via `getSessionByCcSessionId`
 * only when the store has no model recorded for this session (e.g. a session
 * tracked only via the file-watcher/process-watcher path with no statusline
 * render yet). Either way the raw model is mapped to the shared single-letter
 * family tag via `modelFamilyLetter` — the same derivation `GET /statusline`
 * already uses. When neither source yields a model, this fails open to
 * `model: null` rather than throwing or altering the fresh/stale/
 * unknown-session status codes above.
 *
 * Fixed (fix-cc-session-id-bridge, nx-22xz8): this route's `id` path param is
 * CC's own raw hook session id (universe 2 — the same value context-guard.ts
 * and cc-tmux send), NOT nx's internal `sessions.id` primary key (universe 1).
 * The DB-fallback lookup previously called `getSessionById(db, id)`, which
 * queries the primary key — a category mismatch that meant `model` never
 * resolved for any session whose row was created via the file-watcher or HTTP
 * session-start paths (both mint their own internal id, distinct from CC's
 * real session id). The in-memory `store` Map above is unaffected — both
 * PATCH and GET already key it consistently by the same universe-2 id.
 */
export async function handleGetSessionContext(
  _request: Request,
  id: string,
  db?: Db,
): Promise<Response> {
  // Freshness gate — single-sourced via getFreshContextEntry (same TTL check
  // buildSessionStatus uses). A null result means absent OR stale → 404.
  const fresh = getFreshContextEntry(id);
  if (!fresh) {
    return jsonResponse({ error: "no context data for session" }, 404);
  }
  // The gate just proved the entry is present + fresh, so this raw read for the
  // `updatedAt` wire field is safe. It is NOT a second freshness check — the
  // TTL comparison lives only in getFreshContextEntry.
  const entry = store.get(id)!;

  // Store-first: the statusline-ctx-poller-forwarded model, when present.
  let model: string | null = modelFamilyLetter(entry.model) ?? null;
  // DB fallback: only when the store has no model recorded for this session.
  if (model === null && db) {
    const row = await getSessionByCcSessionId(db, id);
    model = modelFamilyLetter({ id: row?.model ?? undefined }) ?? null;
  }
  const body: SessionContextResponse = {
    sessionId: id,
    usedPercentage: fresh.usedPercentage,
    contextWindowSize: fresh.contextWindowSize,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    model,
  };
  return jsonResponse(body);
}

/**
 * Shared write path: upserts `store` for `id` with the given values and the
 * current timestamp. Used by both `handlePatchSessionContext` (validated HTTP
 * body) and `applyStatuslineSnapshot` (in-process caller, e.g. the
 * statusline-ctx poller) so the two never duplicate the write logic.
 */
function _writeContextEntry(
  id: string,
  usedPercentage: number,
  contextWindowSize: number | null,
  model?: { id?: string; display_name?: string },
): void {
  store.set(id, {
    usedPercentage,
    contextWindowSize,
    updatedAt: Date.now(),
    model,
  });
}

/**
 * In-process write path for `id`'s context entry — bypasses the HTTP PATCH
 * route entirely. Intended for callers already running inside this same
 * process (e.g. `statusline-ctx-poller.ts`, which reads local snapshot files
 * `context-guard.ts` already writes reliably and applies them directly here,
 * no network round-trip needed). Writes via the same `_writeContextEntry`
 * `handlePatchSessionContext` uses, so both paths always agree on shape.
 *
 * `model` (optional 4th param, forward-statusline-model) is the raw model
 * payload forwarded from the statusline-ctx snapshot; `handleGetSessionContext`
 * prefers this over its `sessions.model` DB fallback when present.
 */
export function applyStatuslineSnapshot(
  id: string,
  usedPercentage: number,
  contextWindowSize: number | null,
  model?: { id?: string; display_name?: string },
): void {
  _writeContextEntry(id, usedPercentage, contextWindowSize, model);
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

  _writeContextEntry(
    id,
    parsed.data.usedPercentage,
    parsed.data.contextWindowSize ?? null,
  );
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
