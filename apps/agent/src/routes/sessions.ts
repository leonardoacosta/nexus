import type { Db } from "@nexus/db";
import {
  queryActiveSessions,
  queryRecentSessions,
  getSessionById,
} from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { execText, ExecError } from "../utils/exec";

const QUERY_WINDOW_HOURS = 24; // hours of history to include in session queries

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

const SESSIONS_CACHE_TTL_MS = 1_000; // 1 second

/**
 * Module-level singleton cache — retained for backward compatibility.
 * Tests should call `clearSessionsCache()` in `beforeEach`, or use
 * `createSessionHandlers(db)` for full per-test isolation.
 */
let _moduleCache: CacheEntry<SessionRow[]> | null = null;

/** Clear the module-level sessions cache (useful for testing). */
export function clearSessionsCache(): void {
  _moduleCache = null;
}

/**
 * Factory that returns route handlers sharing a private cache instance.
 * Each call to `createSessionHandlers` creates a fresh, isolated cache —
 * ideal for test suites that need per-suite isolation.
 */
export function createSessionHandlers(db: Db) {
  let cache: CacheEntry<SessionRow[]> | null = null;

  async function getCached(): Promise<SessionRow[]> {
    const now = Date.now();
    if (cache && now < cache.expiry) {
      return cache.data;
    }
    const active = await queryActiveSessions(db);
    const recent = await queryRecentSessions(db, QUERY_WINDOW_HOURS);
    const map = new Map<string, SessionRow>();
    for (const row of active) map.set(row.id, row);
    for (const row of recent) {
      if (!map.has(row.id)) map.set(row.id, row);
    }
    const merged = Array.from(map.values());
    cache = { data: merged, expiry: now + SESSIONS_CACHE_TTL_MS };
    return merged;
  }

  return {
    async getSessions(url: URL): Promise<Response> {
      return _handleGetSessions(getCached, url);
    },
    async getSessionById(id: string): Promise<Response> {
      return _handleGetSessionById(db, id);
    },
    /** Reset this instance's cache (useful mid-test). */
    clearCache() {
      cache = null;
    },
  };
}

/** Fetch all displayable sessions (active + recent), using the module-level cache. */
async function getCachedSessions(db: Db): Promise<SessionRow[]> {
  const now = Date.now();
  if (_moduleCache && now < _moduleCache.expiry) {
    return _moduleCache.data;
  }

  const active = await queryActiveSessions(db);
  const recent = await queryRecentSessions(db, QUERY_WINDOW_HOURS);

  // Merge, dedup by id (active takes precedence)
  const map = new Map<string, SessionRow>();
  for (const row of active) map.set(row.id, row);
  for (const row of recent) {
    if (!map.has(row.id)) map.set(row.id, row);
  }

  const merged = Array.from(map.values());
  _moduleCache = { data: merged, expiry: now + SESSIONS_CACHE_TTL_MS };
  return merged;
}

// ── Shared handler logic ───────────────────────────────────────────────────

async function _handleGetSessions(
  fetchSessions: () => Promise<SessionRow[]>,
  url: URL,
): Promise<Response> {
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

  let rows: SessionRow[];
  try {
    rows = await fetchSessions();
  } catch (err) {
    const detail =
      process.env.NODE_ENV !== "production"
        ? String(err instanceof Error ? err.message : err)
        : undefined;
    return new Response(
      JSON.stringify({ error: "internal error", ...(detail ? { detail } : {}) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (projectFilter) {
    rows = rows.filter((s) => s.project === projectFilter);
  }
  if (statusFilter) {
    rows = rows.filter((s) => s.status === statusFilter);
  }

  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function _handleGetSessionById(db: Db, id: string): Promise<Response> {
  let session: SessionRow | null;
  try {
    session = await getSessionById(db, id);
  } catch (err) {
    const detail =
      process.env.NODE_ENV !== "production"
        ? String(err instanceof Error ? err.message : err)
        : undefined;
    return new Response(
      JSON.stringify({ error: "internal error", ...(detail ? { detail } : {}) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
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

// ── Route handlers ─────────────────────────────────────────────────────────

/** GET /sessions — list sessions, optionally filtered by project and/or status. */
export async function handleGetSessions(db: Db, url: URL): Promise<Response> {
  return _handleGetSessions(() => getCachedSessions(db), url);
}

/** GET /sessions/{id} — single session by ID, 404 if not found. */
export async function handleGetSessionById(db: Db, id: string): Promise<Response> {
  return _handleGetSessionById(db, id);
}

// ── POST /session/start ───────────────────────────────────────────────────

/**
 * POST /session/start — spawn a new Claude Code session in a tmux window.
 *
 * Request body: { project: string, path: string }
 * Response: { session_name: string, started: boolean }
 */
export async function handleSessionStart(request: Request): Promise<Response> {
  let body: { project: string; path: string };
  try {
    body = (await request.json()) as { project: string; path: string };
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!body.project || !body.path) {
    return new Response(
      JSON.stringify({ error: "project and path are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 1. Check tmux is available.
  try {
    await execText("which", ["tmux"]);
  } catch {
    return new Response(
      JSON.stringify({ error: "tmux not found -- install tmux on this agent" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // 2. Validate path exists and is a directory.
  const { existsSync, statSync } = await import("node:fs");
  if (!existsSync(body.path) || !statSync(body.path).isDirectory()) {
    return new Response(
      JSON.stringify({ error: `project path does not exist: ${body.path}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 3. Generate unique session name.
  const ts = Date.now();
  const sessionName = `${body.project}-${ts}`;

  // 4. Create tmux window.
  try {
    await execText("tmux", [
      "new-window",
      "-d",
      "-c",
      body.path,
      "-n",
      sessionName,
    ]);
  } catch (err) {
    const stderr = err instanceof ExecError ? err.stderr : String(err);
    return new Response(
      JSON.stringify({ error: `tmux new-window failed: ${stderr}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // 5. Send claude command.
  try {
    await execText("tmux", ["send-keys", "-t", sessionName, "claude", "Enter"]);
  } catch {
    // Best effort — the window was already created.
  }

  return new Response(
    JSON.stringify({ session_name: sessionName, started: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
