import type { Db } from "@nexus/db";
import {
  queryActiveSessions,
  queryRecentSessions,
  getSessionById,
} from "../db/sessions";
import type { SessionRow } from "../db/sessions";

/** Valid status values accepted as query parameter filters. */
const VALID_STATUSES = new Set(["active", "idle", "ended", "stale", "errored"]);

/** Optional filters for GET /sessions. */
export interface SessionListQuery {
  project?: string;
  status?: string;
}

// ── Simple cache with TTL ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

let sessionsCache: CacheEntry<SessionRow[]> | null = null;
const SESSIONS_CACHE_TTL_MS = 1_000; // 1 second

/** Clear the sessions cache (useful for testing). */
export function clearSessionsCache(): void {
  sessionsCache = null;
}

/** Fetch all displayable sessions (active + recent), with caching. */
async function getCachedSessions(db: Db): Promise<SessionRow[]> {
  const now = Date.now();
  if (sessionsCache && now < sessionsCache.expiry) {
    return sessionsCache.data;
  }

  const active = await queryActiveSessions(db);
  const recent = await queryRecentSessions(db, 24);

  // Merge, dedup by id (active takes precedence)
  const map = new Map<string, SessionRow>();
  for (const row of active) map.set(row.id, row);
  for (const row of recent) {
    if (!map.has(row.id)) map.set(row.id, row);
  }

  const merged = Array.from(map.values());
  sessionsCache = { data: merged, expiry: now + SESSIONS_CACHE_TTL_MS };
  return merged;
}

// ── Route handlers ─────────────────────────────────────────────────────────

/** GET /sessions — list sessions, optionally filtered by project and/or status. */
export async function handleGetSessions(db: Db, url: URL): Promise<Response> {
  const projectFilter = url.searchParams.get("project") ?? undefined;
  const statusFilter = url.searchParams.get("status") ?? undefined;

  // Validate status if provided
  if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
    return new Response(
      JSON.stringify({
        error: `invalid status filter: "${statusFilter}". Must be one of: active, idle, ended, stale, errored`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let sessions = await getCachedSessions(db);

  if (projectFilter) {
    sessions = sessions.filter((s) => s.project === projectFilter);
  }
  if (statusFilter) {
    sessions = sessions.filter((s) => s.status === statusFilter);
  }

  return new Response(JSON.stringify(sessions), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** GET /sessions/{id} — single session by ID, 404 if not found. */
export async function handleGetSessionById(db: Db, id: string): Promise<Response> {
  const session = await getSessionById(db, id);
  if (!session) {
    return new Response(
      JSON.stringify({ error: "session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(JSON.stringify(session), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
