import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { createLogger, expandTilde, getAgentId, safeSpawn } from "@nexus/core";
import { queryRecentSessions } from "../db/sessions";
import { upsertProjectLocations } from "../db/project-registry";
import type { ProjectToUpsert } from "../db/project-registry";
import { encodeCursor, parseCursor, parseLimit } from "./cursor";

// ── Logger ─────────────────────────────────────────────────────────────────

const log = createLogger("agent:routes:projects-discovered");

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000; // 5 seconds
/** Sessions active within the last 1 hour are counted as active (aligned with QUERY_WINDOW_HOURS). */
const ACTIVE_SESSION_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
export const QUERY_WINDOW_HOURS = 24; // hours of history to include in session cross-reference
/** Legacy (non-cursor) response cap — preserves existing `truncated: true` semantics. */
const LEGACY_SCAN_CAP = 100;
/**
 * Upper bound on scan size for cursor callers. Large enough that any realistic
 * projects directory fits, small enough that a misconfigured dir can't hang
 * the request indefinitely on git-remote spawns.
 */
const PAGINATED_SCAN_CAP = 1_000;

// ── Pagination constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ── Tilde expansion ────────────────────────────────────────────────────────

/** Expand a leading `~` to the user's home directory, then resolve to absolute. */
export function expandProjectsDir(raw: string): string {
  return path.resolve(expandTilde(raw));
}

// ── Route-level types (agent produces these; client maps to core DiscoveredProject) ──

/** A git-repo entry as returned by this agent's GET /projects/discovered endpoint. */
export interface AgentDiscoveredProject {
  name: string;
  path: string;
  /** Number of sessions currently active (status="active" or last_seen within 1 hour). */
  activeSessions: number;
  /** Total sessions recorded in the 24-hour query window. */
  totalSessions: number;
  /** Git remote URL for origin, used as a stable cross-machine dedup key. Null when unavailable. */
  gitRemoteUrl: string | null;
}

/** Legacy wire format returned by GET /projects/discovered (no cursor/limit). */
export interface AgentDiscoveredProjectsResponse {
  projects: AgentDiscoveredProject[];
  truncated: boolean;
  /** True when projectsDir is not configured for this agent. */
  configured: boolean;
}

/**
 * Paginated wire format returned by GET /projects/discovered when `cursor`
 * or `limit` query params are supplied.
 *
 * `items` is the windowed page sorted by path ascending (the cursor marker
 * is the last emitted item's path). `nextCursor` is the opaque continuation
 * token, or null when the caller has reached the end.
 *
 * `truncated` is intentionally omitted here: cursor callers advance through
 * the full result set page-by-page and don't need the legacy overflow signal.
 */
export interface AgentDiscoveredProjectsPaginatedResponse {
  items: AgentDiscoveredProject[];
  nextCursor: string | null;
  /** True when projectsDir is not configured for this agent. */
  configured: boolean;
}

// ── Git remote URL helper ──────────────────────────────────────────────────

/**
 * Attempt to read the git remote URL for "origin" in the given directory.
 * Returns null on any failure (git not available, no remote, timeout, etc.).
 *
 * Uses `safeSpawn` (Bun) with an `AbortSignal.timeout(500)` to preserve the
 * 500ms cap that the old `spawnSync` call enforced via its `timeout` option.
 */
async function getGitRemoteUrl(projectPath: string): Promise<string | null> {
  try {
    const handle = safeSpawn("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      signal: AbortSignal.timeout(500),
    });
    // stdio default is "pipe" → stdout is a ReadableStream. Narrow defensively
    // in case the default ever changes.
    const stdoutText =
      handle.stdout && typeof handle.stdout !== "number"
        ? await new Response(handle.stdout).text()
        : "";
    const exitCode = await handle.exitCode;
    if (exitCode === 0) {
      return stdoutText.trim() || null;
    }
  } catch {
    // no-op — git not available, not a remote, timeout, or disallowed binary
  }
  return null;
}

// ── Simple cache with TTL ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
  computedAt: number;
}

/**
 * Cached scan result. Separate entries for legacy (100-cap) and paginated
 * (larger cap) callers so we don't re-scan the whole dir on every cursor
 * page, and don't penalise legacy callers with larger scans.
 */
let legacyCache: CacheEntry<AgentDiscoveredProjectsResponse | { error: string }> | null = null;
let paginatedCache: CacheEntry<
  { projects: AgentDiscoveredProject[]; configured: boolean } | { error: string }
> | null = null;

/** Clear the discovered projects caches (useful for testing). */
export function clearDiscoveredProjectsCache(): void {
  legacyCache = null;
  paginatedCache = null;
}

// ── Module-level dedup set ─────────────────────────────────────────────────
// Persists across requests within the same process; reset at the top of each
// cache-miss compute cycle so it tracks the current scan, not prior scans.
let seenCanonicalPaths = new Set<string>();

// ── Scan helpers ───────────────────────────────────────────────────────────

/**
 * Perform the git-repo scan and session cross-reference for a given agent's
 * projectsDir. Stops at `cap` entries. Returns both the (possibly capped)
 * project list and a `truncated` flag.
 *
 * Callers are responsible for input validation (path traversal, absolute,
 * /home/|/Users/ prefix) before invoking this helper.
 */
async function scanProjects(
  projectsDir: string,
  db: Db,
  cap: number,
): Promise<
  | { ok: true; projects: AgentDiscoveredProject[]; truncated: boolean }
  | { ok: false; error: string }
> {
  // Fetch recent sessions to cross-reference
  const recentSessions = await queryRecentSessions(db, QUERY_WINDOW_HOURS);

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ projectsDir, error: message }, "readdirSync failed");
    return { ok: false, error: message };
  }

  const projects: AgentDiscoveredProject[] = [];
  // Reset the module-level dedup set at the start of each new scan cycle.
  seenCanonicalPaths = new Set<string>();
  let truncated = false;

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const fullPath = path.join(projectsDir, entry.name);

    // Resolve symlinks — skip broken ones
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(fullPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ fullPath, error: message }, "realpathSync failed — skipping entry");
      continue;
    }

    // Skip entries that resolve to an already-seen canonical path
    if (seenCanonicalPaths.has(canonicalPath)) continue;

    // Only include directories that contain a .git subdirectory
    if (!fs.existsSync(path.join(canonicalPath, ".git"))) continue;

    seenCanonicalPaths.add(canonicalPath);

    // Cross-reference with recent sessions — count active and total
    const name = entry.name;
    const nowMs = Date.now();

    let activeSessions = 0;
    let totalSessions = 0;

    for (const s of recentSessions) {
      const matchesCwd = s.cwd?.startsWith(canonicalPath) || s.cwd?.startsWith(fullPath);
      // NOTE: schema evolution dropped `sessions.project` (text name). The previous
      // `s.project === name` match cannot be performed without a join on projects.id.
      // For now we rely on cwd match only; the proper join lives in capability 3.
      if (!matchesCwd) continue;

      totalSessions++;

      const isActive =
        s.status === "active" ||
        (s.lastActivity && nowMs - s.lastActivity.getTime() < ACTIVE_SESSION_WINDOW_MS);

      if (isActive) activeSessions++;
    }

    const gitRemoteUrl = await getGitRemoteUrl(canonicalPath);
    projects.push({ name, path: canonicalPath, activeSessions, totalSessions, gitRemoteUrl });

    if (projects.length >= cap) {
      truncated = true;
      break;
    }
  }

  return { ok: true, projects, truncated };
}

/**
 * Resolve the agent row and validate its projectsDir field. Returns either a
 * successful resolution (absolute, validated path) or a Response to short-
 * circuit the handler with.
 */
async function resolveAgentProjectsDir(
  db: Db,
): Promise<
  | { kind: "ok"; agent: { id: string }; projectsDir: string }
  | { kind: "response"; response: Response }
  | { kind: "unconfigured"; agent: { id: string } }
> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.id, getAgentId()))
    .limit(1);

  const agent = rows[0];
  if (!agent) {
    return {
      kind: "response",
      response: new Response(JSON.stringify({ error: "Agent not registered" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  const rawProjectsDir = (agent.projectsDir ?? "").trim();

  if (!rawProjectsDir) {
    return { kind: "unconfigured", agent };
  }

  if (rawProjectsDir.includes("..")) {
    return {
      kind: "response",
      response: new Response(
        JSON.stringify({ error: "projectsDir must not contain path traversal sequences (..)" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  const projectsDir = expandProjectsDir(rawProjectsDir);

  if (!path.isAbsolute(projectsDir)) {
    return {
      kind: "response",
      response: new Response(
        JSON.stringify({ error: "projectsDir must resolve to an absolute path" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (!projectsDir.startsWith("/home/") && !projectsDir.startsWith("/Users/")) {
    return {
      kind: "response",
      response: new Response(
        JSON.stringify({
          error: `projectsDir must resolve under /home/ or /Users/ (got: ${projectsDir})`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { kind: "ok", agent, projectsDir };
}

// ── Route handler ──────────────────────────────────────────────────────────

/**
 * GET /projects/discovered — git repos found under the agent's projectsDir.
 *
 * Pagination:
 * - No `cursor` and no `limit` query params: legacy behavior — returns
 *   `{ projects, truncated, configured }` with `truncated: true` when the
 *   scan exceeds 100 entries (existing contract).
 * - `cursor` or `limit` present: returns
 *   `{ items, nextCursor, configured }`. The cursor is an opaque base64
 *   string (internally the last-seen path); callers MUST treat it as opaque.
 *   Full scan window is raised to 1000 entries so pagination can cover the
 *   whole directory; beyond that a page ends with nextCursor=null even if
 *   more items exist on disk.
 *
 * Invalid cursors produce a 400 response without leaking the encoding format.
 * `limit` is silently clamped to [1, 200]; default is 50.
 */
export async function handleGetDiscoveredProjects(db: Db, url?: URL): Promise<Response> {
  const start = Date.now();
  const route = "/projects/discovered";

  const rawCursor = url?.searchParams.get("cursor") ?? null;
  const rawLimit = url?.searchParams.get("limit") ?? null;
  const paginated = rawCursor !== null || rawLimit !== null;

  // Validate cursor up front so bad input fails before any DB/scan work.
  let cursorMarker: string | null = null;
  if (rawCursor !== null) {
    cursorMarker = parseCursor(rawCursor);
    if (cursorMarker === null) {
      log.info({ route }, "rejected request with invalid cursor");
      return new Response(
        JSON.stringify({ error: "invalid cursor" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const limit = parseLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
  if (rawLimit !== null) {
    const requested = Number(rawLimit);
    if (Number.isFinite(requested) && requested > MAX_LIMIT) {
      log.warn(
        { route, requested, clampedTo: MAX_LIMIT },
        "limit exceeded max — clamped",
      );
    }
  }

  const now = Date.now();

  // ── Legacy path (no cursor, no limit) ─────────────────────────────────
  if (!paginated) {
    if (legacyCache && now < legacyCache.expiry) {
      const durationMs = Date.now() - start;
      const cached = legacyCache.data;
      const count = "projects" in cached ? cached.projects.length : 0;
      const cacheAge = now - legacyCache.computedAt;
      log.info({ route, durationMs, count, fromCache: true }, "projects-discovered request");
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache-Age": String(cacheAge),
          "X-Cache-TTL": String(CACHE_TTL_MS),
        },
      });
    }

    const resolved = await resolveAgentProjectsDir(db);
    if (resolved.kind === "response") return resolved.response;
    if (resolved.kind === "unconfigured") {
      log.info(
        { route, agentId: resolved.agent.id },
        `projectsDir not configured for agent ${resolved.agent.id} — returning empty project list`,
      );
      const empty: AgentDiscoveredProjectsResponse = {
        projects: [],
        truncated: false,
        configured: false,
      };
      const computedAt = Date.now();
      legacyCache = { data: empty, expiry: computedAt + CACHE_TTL_MS, computedAt };
      const durationMs = Date.now() - start;
      log.info({ route, durationMs, count: 0, fromCache: false }, "projects-discovered request");
      return new Response(JSON.stringify(empty), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache-Age": "0",
          "X-Cache-TTL": String(CACHE_TTL_MS),
        },
      });
    }

    const { agent, projectsDir } = resolved;
    const scan = await scanProjects(projectsDir, db, LEGACY_SCAN_CAP);
    if (!scan.ok) {
      const errResp = { error: scan.error };
      const computedAt = Date.now();
      legacyCache = { data: errResp, expiry: computedAt + CACHE_TTL_MS, computedAt };
      return new Response(JSON.stringify(errResp), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache-Age": "0",
          "X-Cache-TTL": String(CACHE_TTL_MS),
        },
      });
    }

    scan.projects.sort((a, b) => a.name.localeCompare(b.name));

    // Upsert discovered projects into the canonical registry.
    // Awaited (not fire-and-forget) so data is consistent before responding.
    const toUpsert: ProjectToUpsert[] = scan.projects.map((p) => ({
      name: p.name,
      path: p.path,
      activeSessions: p.activeSessions,
      totalSessions: p.totalSessions,
      gitRemoteUrl: p.gitRemoteUrl,
    }));
    try {
      await upsertProjectLocations(db, agent.id, toUpsert);
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "project registry upsert failed — non-fatal",
      );
    }

    const result: AgentDiscoveredProjectsResponse = {
      projects: scan.projects,
      truncated: scan.truncated,
      configured: true,
    };
    const computedAt = Date.now();
    legacyCache = { data: result, expiry: computedAt + CACHE_TTL_MS, computedAt };
    const durationMs = Date.now() - start;
    log.info({ route, durationMs, count: scan.projects.length, fromCache: false }, "projects-discovered request");
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Cache-Age": "0",
        "X-Cache-TTL": String(CACHE_TTL_MS),
      },
    });
  }

  // ── Paginated path (cursor and/or limit) ──────────────────────────────
  let scanData: { projects: AgentDiscoveredProject[]; configured: boolean };
  if (paginatedCache && now < paginatedCache.expiry) {
    const cached = paginatedCache.data;
    if ("error" in cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Cache-Age": String(now - paginatedCache.computedAt),
          "X-Cache-TTL": String(CACHE_TTL_MS),
        },
      });
    }
    scanData = cached;
    log.info(
      { route, count: scanData.projects.length, fromCache: true, paginated: true },
      "projects-discovered request (cache hit)",
    );
  } else {
    const resolved = await resolveAgentProjectsDir(db);
    if (resolved.kind === "response") return resolved.response;
    if (resolved.kind === "unconfigured") {
      scanData = { projects: [], configured: false };
      const computedAt = Date.now();
      paginatedCache = { data: scanData, expiry: computedAt + CACHE_TTL_MS, computedAt };
    } else {
      const { agent, projectsDir } = resolved;
      const scan = await scanProjects(projectsDir, db, PAGINATED_SCAN_CAP);
      if (!scan.ok) {
        const errResp = { error: scan.error };
        const computedAt = Date.now();
        paginatedCache = { data: errResp, expiry: computedAt + CACHE_TTL_MS, computedAt };
        return new Response(JSON.stringify(errResp), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache-Age": "0",
            "X-Cache-TTL": String(CACHE_TTL_MS),
          },
        });
      }

      // Sort by path (cursor is path-based) — stable and covers the case
      // where two repos share a name across subtrees.
      scan.projects.sort((a, b) => a.path.localeCompare(b.path));

      const toUpsert: ProjectToUpsert[] = scan.projects.map((p) => ({
        name: p.name,
        path: p.path,
        activeSessions: p.activeSessions,
        totalSessions: p.totalSessions,
        gitRemoteUrl: p.gitRemoteUrl,
      }));
      try {
        await upsertProjectLocations(db, agent.id, toUpsert);
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "project registry upsert failed — non-fatal",
        );
      }

      scanData = { projects: scan.projects, configured: true };
      const computedAt = Date.now();
      paginatedCache = { data: scanData, expiry: computedAt + CACHE_TTL_MS, computedAt };
    }
    log.info(
      { route, count: scanData.projects.length, fromCache: false, paginated: true },
      "projects-discovered request",
    );
  }

  // Filter past the cursor (exclusive) and cap at limit.
  const filtered = cursorMarker !== null
    ? scanData.projects.filter((p) => p.path > cursorMarker!)
    : scanData.projects;

  const page = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit && page.length > 0
      ? encodeCursor(page[page.length - 1]!.path)
      : null;

  const body: AgentDiscoveredProjectsPaginatedResponse = {
    items: page,
    nextCursor,
    configured: scanData.configured,
  };

  const durationMs = Date.now() - start;
  log.info(
    { route, durationMs, pageSize: page.length, hasNextCursor: nextCursor !== null },
    "paginated shape served",
  );

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
