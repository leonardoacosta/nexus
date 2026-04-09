import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { eq } from "drizzle-orm";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createLogger } from "@nexus/core";
import { queryRecentSessions } from "../db/sessions";
import { upsertProjectLocations } from "../db/project-registry";
import type { ProjectToUpsert } from "../db/project-registry";

// ── Logger ─────────────────────────────────────────────────────────────────

const log = createLogger("agent:routes:projects-discovered");

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000; // 5 seconds
/** Sessions active within the last 1 hour are counted as active (aligned with QUERY_WINDOW_HOURS). */
const ACTIVE_SESSION_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
export const QUERY_WINDOW_HOURS = 24; // hours of history to include in session cross-reference

// ── Tilde expansion ────────────────────────────────────────────────────────

/** Expand a leading `~` to the user's home directory, then resolve to absolute. */
export function expandProjectsDir(raw: string): string {
  const expanded = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.resolve(expanded);
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

/** Wire format returned by GET /projects/discovered. */
export interface AgentDiscoveredProjectsResponse {
  projects: AgentDiscoveredProject[];
  truncated: boolean;
  /** True when projectsDir is not configured for this agent. */
  configured: boolean;
}

// ── Git remote URL helper ──────────────────────────────────────────────────

/**
 * Attempt to read the git remote URL for "origin" in the given directory.
 * Returns null on any failure (git not available, no remote, timeout, etc.).
 */
function getGitRemoteUrl(projectPath: string): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      timeout: 500,
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim() || null;
    }
  } catch {
    // no-op — git not available or not a remote
  }
  return null;
}

// ── Simple cache with TTL ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
  computedAt: number;
}

let discoveredCache: CacheEntry<AgentDiscoveredProjectsResponse | { error: string }> | null = null;

/** Clear the discovered projects cache (useful for testing). */
export function clearDiscoveredProjectsCache(): void {
  discoveredCache = null;
}

// ── Module-level dedup set ─────────────────────────────────────────────────
// Persists across requests within the same process; reset at the top of each
// cache-miss compute cycle so it tracks the current scan, not prior scans.
let seenCanonicalPaths = new Set<string>();

// ── Route handler ──────────────────────────────────────────────────────────

/** GET /projects/discovered — git repos found under the agent's projectsDir. */
export async function handleGetDiscoveredProjects(db: Db): Promise<Response> {
  const start = Date.now();
  const route = "/projects/discovered";

  const now = Date.now();
  if (discoveredCache && now < discoveredCache.expiry) {
    const durationMs = Date.now() - start;
    const cached = discoveredCache.data;
    const count = "projects" in cached ? (cached as AgentDiscoveredProjectsResponse).projects.length : 0;
    const cacheAge = now - discoveredCache.computedAt;
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

  // 1. Look up the agent row by hostname
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.id, os.hostname()))
    .limit(1);

  const agent = rows[0];
  if (!agent) {
    return new Response(JSON.stringify({ error: "Agent not registered" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawProjectsDir = (agent.projectsDir ?? "").trim();

  // 4. Empty projectsDir — return early without scanning
  if (!rawProjectsDir) {
    log.info(
      { route, agentId: agent.id },
      `projectsDir not configured for agent ${agent.id} — returning empty project list`,
    );
    const empty: AgentDiscoveredProjectsResponse = {
      projects: [],
      truncated: false,
      configured: false,
    };
    const computedAt = Date.now();
    discoveredCache = { data: empty, expiry: computedAt + CACHE_TTL_MS, computedAt };
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

  // 11.1 Input validation — reject path traversal
  if (rawProjectsDir.includes("..")) {
    return new Response(
      JSON.stringify({ error: "projectsDir must not contain path traversal sequences (..)" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 3. Tilde expansion and absolute-path check
  const projectsDir = expandProjectsDir(rawProjectsDir);

  if (!path.isAbsolute(projectsDir)) {
    return new Response(
      JSON.stringify({ error: "projectsDir must resolve to an absolute path" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 7.1 Require expanded path to start with /home/ or /Users/
  if (!projectsDir.startsWith("/home/") && !projectsDir.startsWith("/Users/")) {
    return new Response(
      JSON.stringify({
        error: `projectsDir must resolve under /home/ or /Users/ (got: ${projectsDir})`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 7. Fetch recent sessions to cross-reference
  const recentSessions = await queryRecentSessions(db, QUERY_WINDOW_HOURS);

  // 5-6. Scan projectsDir one level deep for git repos
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ route, projectsDir, error: message }, "readdirSync failed");
    const errResp = { error: message };
    const computedAt = Date.now();
    discoveredCache = { data: errResp, expiry: computedAt + CACHE_TTL_MS, computedAt };
    return new Response(JSON.stringify(errResp), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Cache-Age": "0",
        "X-Cache-TTL": String(CACHE_TTL_MS),
      },
    });
  }

  const projects: AgentDiscoveredProject[] = [];
  // Reset the module-level dedup set at the start of each new scan cycle.
  seenCanonicalPaths = new Set<string>();
  let truncated = false;

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const fullPath = path.join(projectsDir, entry.name);

    // 6.1 Resolve symlinks — skip broken ones
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(fullPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ route, fullPath, error: message }, "realpathSync failed — skipping entry");
      continue;
    }

    // 6.2 Skip entries that resolve to an already-seen canonical path
    if (seenCanonicalPaths.has(canonicalPath)) continue;

    // Only include directories that contain a .git subdirectory
    if (!fs.existsSync(path.join(canonicalPath, ".git"))) continue;

    seenCanonicalPaths.add(canonicalPath);

    // 8. Cross-reference with recent sessions — count active and total
    const name = entry.name;
    const nowMs = Date.now();

    let activeSessions = 0;
    let totalSessions = 0;

    for (const s of recentSessions) {
      const matchesCwd = s.cwd?.startsWith(canonicalPath) || s.cwd?.startsWith(fullPath);
      const matchesProject = s.project === name;
      if (!matchesCwd && !matchesProject) continue;

      totalSessions++;

      const isActive =
        s.status === "active" ||
        (s.lastActivity && nowMs - s.lastActivity.getTime() < ACTIVE_SESSION_WINDOW_MS);

      if (isActive) activeSessions++;
    }

    const gitRemoteUrl = getGitRemoteUrl(canonicalPath);
    projects.push({ name, path: canonicalPath, activeSessions, totalSessions, gitRemoteUrl });

    // 9. Cap at 100 results
    if (projects.length >= 100) {
      truncated = true;
      break;
    }
  }

  // Sort alphabetically by name
  projects.sort((a, b) => a.name.localeCompare(b.name));

  // Upsert discovered projects into the canonical registry.
  // Awaited (not fire-and-forget) so data is consistent before responding.
  const toUpsert: ProjectToUpsert[] = projects.map((p) => ({
    name: p.name,
    path: p.path,
    activeSessions: p.activeSessions,
    totalSessions: p.totalSessions,
    gitRemoteUrl: p.gitRemoteUrl,
  }));

  try {
    await upsertProjectLocations(db, agent.id, toUpsert);
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, "project registry upsert failed — non-fatal");
  }

  const result: AgentDiscoveredProjectsResponse = {
    projects,
    truncated,
    configured: true,
  };

  const computedAt = Date.now();
  discoveredCache = { data: result, expiry: computedAt + CACHE_TTL_MS, computedAt };

  const durationMs = Date.now() - start;
  log.info({ route, durationMs, count: projects.length, fromCache: false }, "projects-discovered request");

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Cache-Age": "0",
      "X-Cache-TTL": String(CACHE_TTL_MS),
    },
  });
}
