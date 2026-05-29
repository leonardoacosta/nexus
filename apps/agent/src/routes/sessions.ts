import type { Db } from "@nexus/db";
import { sessions, sessionTokenTurns, eq, sql } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import {
  queryActiveSessions,
  queryRecentSessions,
  getSessionById,
  upsertSession,
  updateSessionGitOrigin,
} from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { execText, ExecError } from "../utils/exec";
import { reconcileOnce } from "../services/process-watcher";
import { resolveGitOrigin } from "../services/git-project";
import { resolveProject } from "../services/git-project-resolver";
import { linkSpecToSession } from "../services/session-spec-link";

const log = createLogger("agent:routes:sessions");

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

interface SessionsCacheBucket {
  /** Cache for `withFingerprint=false` (default — all rows). */
  all: CacheEntry<SessionRow[]> | null;
  /** Cache for `withFingerprint=true` (filtered rows). */
  fingerprinted: CacheEntry<SessionRow[]> | null;
}

const SESSIONS_CACHE_TTL_MS = 1_000; // 1 second

/**
 * Module-level singleton cache — retained for backward compatibility.
 * Tests should call `clearSessionsCache()` in `beforeEach`, or use
 * `createSessionHandlers(db)` for full per-test isolation.
 */
const _moduleCache: SessionsCacheBucket = { all: null, fingerprinted: null };

/** Clear the module-level sessions cache (useful for testing). */
export function clearSessionsCache(): void {
  _moduleCache.all = null;
  _moduleCache.fingerprinted = null;
}

/**
 * Factory that returns route handlers sharing a private cache instance.
 * Each call to `createSessionHandlers` creates a fresh, isolated cache —
 * ideal for test suites that need per-suite isolation.
 */
export function createSessionHandlers(db: Db) {
  const cache: SessionsCacheBucket = { all: null, fingerprinted: null };

  async function getCached(withFingerprint: boolean): Promise<SessionRow[]> {
    const now = Date.now();
    const slot = withFingerprint ? "fingerprinted" : "all";
    const existing = cache[slot];
    if (existing && now < existing.expiry) {
      return existing.data;
    }
    const active = await queryActiveSessions(db, { withFingerprint });
    const recent = await queryRecentSessions(db, QUERY_WINDOW_HOURS, {
      withFingerprint,
    });
    const map = new Map<string, SessionRow>();
    for (const row of active) map.set(row.id, row);
    for (const row of recent) {
      if (!map.has(row.id)) map.set(row.id, row);
    }
    const merged = Array.from(map.values());
    cache[slot] = { data: merged, expiry: now + SESSIONS_CACHE_TTL_MS };
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
      cache.all = null;
      cache.fingerprinted = null;
    },
  };
}

/** Fetch all displayable sessions (active + recent), using the module-level cache. */
async function getCachedSessions(
  db: Db,
  withFingerprint: boolean,
): Promise<SessionRow[]> {
  const now = Date.now();
  const slot = withFingerprint ? "fingerprinted" : "all";
  const existing = _moduleCache[slot];
  if (existing && now < existing.expiry) {
    return existing.data;
  }

  const active = await queryActiveSessions(db, { withFingerprint });
  const recent = await queryRecentSessions(db, QUERY_WINDOW_HOURS, {
    withFingerprint,
  });

  // Merge, dedup by id (active takes precedence)
  const map = new Map<string, SessionRow>();
  for (const row of active) map.set(row.id, row);
  for (const row of recent) {
    if (!map.has(row.id)) map.set(row.id, row);
  }

  const merged = Array.from(map.values());
  _moduleCache[slot] = { data: merged, expiry: now + SESSIONS_CACHE_TTL_MS };
  return merged;
}

// ── Shared handler logic ───────────────────────────────────────────────────

async function _handleGetSessions(
  fetchSessions: (withFingerprint: boolean) => Promise<SessionRow[]>,
  url: URL,
): Promise<Response> {
  const projectFilter = url.searchParams.get("project") ?? undefined;
  const statusFilter = url.searchParams.get("status") ?? undefined;
  const withFingerprint =
    url.searchParams.get("withFingerprint") === "true";

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
    rows = await fetchSessions(withFingerprint);
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
    // NOTE: schema evolution dropped `sessions.project` (text name) in favor of
    // `sessions.projectId` (uuid FK). This filter now matches on projectId only —
    // callers that used to pass a project name will no longer match. A proper
    // join-based filter is part of the dashboard collapse work (capability 3).
    rows = rows.filter((s) => s.projectId === projectFilter);
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
  return _handleGetSessions(
    (withFingerprint) => getCachedSessions(db, withFingerprint),
    url,
  );
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
 * Response: { session_name: string, started: boolean, session_id?: string, pid?: number }
 *
 * Persistence (fix-agent-cc-session-tracking 2.1): after the tmux window is
 * created, we capture the spawned shell PID via
 * `tmux list-windows -t <name> -F '#{pane_pid}'` and persist a new session
 * row carrying `pid`, `tmuxTarget`, `cwd`, and `model = "claude"` so that
 * `/sessions?withFingerprint=true` immediately surfaces the row. The DB
 * argument is optional — when omitted (legacy callers / tests) the handler
 * still returns 200 but skips persistence.
 */
export async function handleSessionStart(
  request: Request,
  db?: Db,
): Promise<Response> {
  let body: { project: string; path: string; spec_slug?: string };
  try {
    body = (await request.json()) as {
      project: string;
      path: string;
      spec_slug?: string;
    };
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

  // 4b. Capture the spawned shell PID for the new window. This is the PID
  //     that will host the `claude` process once `send-keys` fires. Best
  //     effort — if pgrep / tmux output parsing fails we still surface the
  //     tmuxTarget so `withFingerprint` filtering succeeds.
  let pid: number | null = null;
  try {
    const out = await execText("tmux", [
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{pane_pid}",
    ]);
    const first = out.trim().split("\n")[0]?.trim() ?? "";
    const parsed = parseInt(first, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      pid = parsed;
    }
  } catch (err) {
    log.warn(
      { sessionName, error: err instanceof Error ? err.message : String(err) },
      "tmux list-windows failed; persisting row without pid",
    );
  }

  // 5. Send claude command.
  try {
    await execText("tmux", ["send-keys", "-t", sessionName, "claude", "Enter"]);
  } catch {
    // Best effort — the window was already created.
  }

  // 6. Persist the session row so /sessions surfaces it. The row carries
  //    enough CC-discriminator fields (tmuxTarget, pid, cwd, model) to pass
  //    the `withFingerprint` filter introduced by task 2.2. Failures are
  //    logged but not fatal — the tmux window is already live and useful.
  if (db) {
    const now = new Date();
    try {
      await upsertSession(db, {
        id: sessionName,
        pid: pid ?? 0,
        project: undefined,
        projectId: null,
        machine: "local",
        cwd: body.path,
        branch: null,
        startedAt: now,
        lastHeartbeat: now,
        endedAt: null,
        status: "active",
        spec: null,
        command: null,
        agent: null,
        tmuxSession: null,
        ccSessionId: null,
        tmuxTarget: sessionName,
        rateLimitUtilization: null,
        rateLimitType: null,
        totalCostUsd: null,
        model: "claude",
        credentialId: null,
        credentialFingerprint: null,
        sessionType: "managed",
        // session-enrichment: no CC hook observed yet for a freshly-spawned
        // managed session — the hook-processing spine fills this in.
        agentState: null,
        parentSessionId: null,
        childRole: null,
      });

      // Fire-and-forget git project resolution. /session/start does not
      // flow through `processHookEvent` (it's a managed-spawn route, not a
      // hook ingress) — but the same enrichment applies: a managed session
      // should carry git_provider/git_owner_repo/project_id so dashboards
      // can group by repo. session-row-enrichment-v1 § 1.5 wire-in alt-path.
      resolveProject(body.path, db)
        .then(async (project) => {
          if (!project) {
            // Resolver returned null — fall back to the narrower legacy
            // path so the row still gets provider/ownerRepo when the
            // registry lookup didn't apply.
            const origin = await resolveGitOrigin(body.path);
            if (origin) {
              await updateSessionGitOrigin(db, sessionName, origin);
            }
            return;
          }
          await updateSessionGitOrigin(db, sessionName, {
            provider: project.provider,
            ownerRepo: project.ownerRepo,
          });
          if (project.projectId) {
            await db
              .update(sessions)
              .set({ projectId: project.projectId })
              .where(eq(sessions.id, sessionName));
          }
        })
        .catch((err: unknown) => {
          log.warn(
            { sessionName, error: err instanceof Error ? err.message : String(err) },
            "git project enrichment failed for /session/start (non-fatal)",
          );
        });
    } catch (err) {
      log.error(
        { sessionName, error: err instanceof Error ? err.message : String(err) },
        "failed to persist /session/start row",
      );
    }
  }

  // ── 7. Optional spec linkage (specs-tab-start-on-spec, task 2.2) ────────
  //
  // When the caller passes `spec_slug`, insert a `spec_sessions` row so the
  // Swift dashboard can later render a per-row session-count chip on the
  // Specs tab. Failure to link MUST NOT roll back the spawn — the tmux
  // window is already live and useful. We pino-warn and surface a
  // `spec_linked: false` + `spec_link_error: "..."` on the response so the
  // caller can show a "session started, linkage skipped" toast.
  let specLinked: boolean | undefined;
  let specLinkError: string | undefined;
  if (db && body.spec_slug) {
    try {
      const result = await linkSpecToSession({
        db,
        project: body.project,
        specSlug: body.spec_slug,
        sessionId: sessionName,
      });
      specLinked = result.linked;
      if (!result.linked) {
        specLinkError = result.error ?? "unknown";
      }
    } catch (err) {
      log.warn(
        {
          sessionName,
          spec_slug: body.spec_slug,
          error: err instanceof Error ? err.message : String(err),
        },
        "spec link unexpected throw (degraded gracefully)",
      );
      specLinked = false;
      specLinkError = "internal error";
    }
  }

  return new Response(
    JSON.stringify({
      session_name: sessionName,
      started: true,
      ...(pid !== null ? { pid } : {}),
      session_id: sessionName,
      ...(specLinked !== undefined ? { spec_linked: specLinked } : {}),
      ...(specLinkError !== undefined ? { spec_link_error: specLinkError } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── GET /sessions/{id}/tokens ─────────────────────────────────────────────

/**
 * GET /sessions/{id}/tokens — per-turn token breakdown + aggregates.
 *
 * Returns all token turns for a session ordered by timestamp, plus
 * computed aggregates (total tokens, cost, turn count).
 */
export async function handleGetSessionTokens(
  db: Db,
  id: string,
): Promise<Response> {
  // Verify session exists
  const session = await getSessionById(db, id);
  if (!session) {
    return new Response(
      JSON.stringify({ error: "session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Fetch all turns for this session
  const turns = await db
    .select()
    .from(sessionTokenTurns)
    .where(eq(sessionTokenTurns.sessionId, id))
    .orderBy(sessionTokenTurns.ts);

  // Compute aggregates
  const aggregates = {
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
    cost_usd: null as number | null,
    turn_count: turns.length,
  };

  let costAccumulator: number | null = 0;
  for (const turn of turns) {
    aggregates.input += turn.inputTokens;
    aggregates.output += turn.outputTokens;
    aggregates.cache_creation += turn.cacheCreationInputTokens;
    aggregates.cache_read += turn.cacheReadInputTokens;
    if (turn.costUsd !== null && costAccumulator !== null) {
      costAccumulator += parseFloat(turn.costUsd);
    } else {
      costAccumulator = null;
    }
  }
  aggregates.cost_usd = costAccumulator;

  return new Response(
    JSON.stringify({ turns, aggregates }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── POST /sessions/probe ───────────────────────────────────────────────────

/**
 * POST /sessions/probe — force-trigger an immediate process-watcher
 * reconciliation pass instead of waiting for the next interval tick.
 *
 * Useful from the menu bar / dashboard when the operator wants to refresh
 * the session list NOW (e.g. just spawned a `claude` in another terminal
 * and doesn't want to wait 30s). Returns the counts of rows that changed.
 *
 * Response: `{ reconciledCreated: number, reconciledClosed: number }`
 */
export async function handleSessionsProbe(db: Db): Promise<Response> {
  try {
    const result = await reconcileOnce(db);
    return new Response(
      JSON.stringify({
        reconciledCreated: result.created,
        reconciledClosed: result.closed,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "sessions probe failed",
    );
    return new Response(
      JSON.stringify({ error: "reconciliation failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
