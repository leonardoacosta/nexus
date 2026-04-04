import type { Database } from "bun:sqlite";
import {
  queryActiveSessions,
  queryRecentSessions,
  getSessionById,
} from "../db/sessions";
import type { SessionRow } from "../db/sessions";

/** Valid status values accepted as query parameter filters. */
const VALID_STATUSES = new Set(["active", "idle", "ended"]);

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
function getCachedSessions(db: Database): SessionRow[] {
  const now = Date.now();
  if (sessionsCache && now < sessionsCache.expiry) {
    return sessionsCache.data;
  }

  const active = queryActiveSessions(db);
  const recent = queryRecentSessions(db, 24);

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
export function handleGetSessions(db: Database, url: URL): Response {
  const projectFilter = url.searchParams.get("project") ?? undefined;
  const statusFilter = url.searchParams.get("status") ?? undefined;

  // Validate status if provided
  if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
    return new Response(
      JSON.stringify({
        error: `invalid status filter: "${statusFilter}". Must be one of: active, idle, ended`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let sessions = getCachedSessions(db);

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
export function handleGetSessionById(db: Database, id: string): Response {
  const session = getSessionById(db, id);
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
