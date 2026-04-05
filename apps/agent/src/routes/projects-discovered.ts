import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { eq } from "drizzle-orm";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "@nexus/core";
import { queryRecentSessions } from "../db/sessions";

// ── Logger ─────────────────────────────────────────────────────────────────

const log = createLogger("agent:routes:projects-discovered");

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
  hasActiveSessions: boolean;
}

/** Wire format returned by GET /projects/discovered. */
export interface AgentDiscoveredProjectsResponse {
  projects: AgentDiscoveredProject[];
  truncated: boolean;
}

// ── Simple cache with TTL ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

let discoveredCache: CacheEntry<AgentDiscoveredProjectsResponse | { error: string }> | null = null;
const CACHE_TTL_MS = 5_000; // 5 seconds

/** Clear the discovered projects cache (useful for testing). */
export function clearDiscoveredProjectsCache(): void {
  discoveredCache = null;
}

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
    log.info({ route, durationMs, count, fromCache: true }, "projects-discovered request");
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: { "Content-Type": "application/json" },
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

  const rawProjectsDir = agent.projectsDir ?? "";

  // 4. Empty projectsDir — return early without scanning
  if (!rawProjectsDir) {
    const empty: AgentDiscoveredProjectsResponse = {
      projects: [],
      truncated: false,
    };
    discoveredCache = { data: empty, expiry: now + CACHE_TTL_MS };
    const durationMs = Date.now() - start;
    log.info({ route, durationMs, count: 0, fromCache: false }, "projects-discovered request");
    return new Response(JSON.stringify(empty), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Tilde expansion and absolute-path check
  const projectsDir = expandProjectsDir(rawProjectsDir);

  if (!path.isAbsolute(projectsDir)) {
    return new Response(
      JSON.stringify({ error: "projectsDir must resolve to an absolute path" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 7. Fetch recent sessions to cross-reference
  const recentSessions = await queryRecentSessions(db, 24);

  // 5-6. Scan projectsDir one level deep for git repos
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ route, projectsDir, error: message }, "readdirSync failed");
    const errResp = { error: message };
    discoveredCache = { data: errResp, expiry: now + CACHE_TTL_MS };
    return new Response(JSON.stringify(errResp), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const projects: AgentDiscoveredProject[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const fullPath = path.join(projectsDir, entry.name);

    // Only include directories that contain a .git subdirectory
    if (!fs.existsSync(path.join(fullPath, ".git"))) continue;

    // 8. Cross-reference with recent sessions
    const name = entry.name;
    const hasActiveSessions = recentSessions.some(
      (s) => s.cwd?.startsWith(fullPath) || s.project === name,
    );

    projects.push({ name, path: fullPath, hasActiveSessions });

    // 9. Cap at 100 results
    if (projects.length >= 100) {
      truncated = true;
      break;
    }
  }

  // Sort alphabetically by name
  projects.sort((a, b) => a.name.localeCompare(b.name));

  const result: AgentDiscoveredProjectsResponse = {
    projects,
    truncated,
  };

  discoveredCache = { data: result, expiry: now + CACHE_TTL_MS };

  const durationMs = Date.now() - start;
  log.info({ route, durationMs, count: projects.length, fromCache: false }, "projects-discovered request");

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
