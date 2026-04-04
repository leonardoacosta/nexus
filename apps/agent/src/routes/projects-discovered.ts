import type { Db } from "@nexus/db";
import { agents } from "@nexus/db";
import { eq } from "drizzle-orm";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { queryRecentSessions } from "../db/sessions";

// ── Types ──────────────────────────────────────────────────────────────────

interface DiscoveredProject {
  name: string;
  path: string;
  hasActiveSessions: boolean;
}

interface DiscoveredProjectsResponse {
  projects: DiscoveredProject[];
  projectsDir: string;
  total: number;
}

// ── Simple cache with TTL ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

let discoveredCache: CacheEntry<DiscoveredProjectsResponse> | null = null;
const CACHE_TTL_MS = 5_000; // 5 seconds

/** Clear the discovered projects cache (useful for testing). */
export function clearDiscoveredProjectsCache(): void {
  discoveredCache = null;
}

// ── Route handler ──────────────────────────────────────────────────────────

/** GET /projects/discovered — git repos found under the agent's projectsDir. */
export async function handleGetDiscoveredProjects(db: Db): Promise<Response> {
  const now = Date.now();
  if (discoveredCache && now < discoveredCache.expiry) {
    return new Response(JSON.stringify(discoveredCache.data), {
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

  const projectsDir = agent.projectsDir ?? "";

  // 4. Empty projectsDir — return early without scanning
  if (!projectsDir) {
    const empty: DiscoveredProjectsResponse = {
      projects: [],
      projectsDir: "",
      total: 0,
    };
    discoveredCache = { data: empty, expiry: now + CACHE_TTL_MS };
    return new Response(JSON.stringify(empty), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 7. Fetch recent sessions to cross-reference
  const recentSessions = await queryRecentSessions(db, 24);

  // 5-6. Scan projectsDir one level deep for git repos
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist or isn't readable
    const fallback: DiscoveredProjectsResponse = {
      projects: [],
      projectsDir,
      total: 0,
    };
    discoveredCache = { data: fallback, expiry: now + CACHE_TTL_MS };
    return new Response(JSON.stringify(fallback), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const projects: DiscoveredProject[] = [];

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
    if (projects.length >= 100) break;
  }

  // Sort alphabetically by name
  projects.sort((a, b) => a.name.localeCompare(b.name));

  const result: DiscoveredProjectsResponse = {
    projects,
    projectsDir,
    total: projects.length,
  };

  discoveredCache = { data: result, expiry: now + CACHE_TTL_MS };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
