import type { Db } from "@nexus/db";
import type { Project } from "@nexus/core";
import { queryRecentSessions } from "../db/sessions";
import type { SessionRow } from "../db/sessions";

// ── Simple cache with TTL ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

let projectsCache: CacheEntry<Project[]> | null = null;
const PROJECTS_CACHE_TTL_MS = 5_000; // 5 seconds

/** Clear the projects cache (useful for testing). */
export function clearProjectsCache(): void {
  projectsCache = null;
}

/** Aggregate sessions into project summaries. */
function aggregateProjects(sessions: SessionRow[]): Project[] {
  const projectMap = new Map<
    string,
    { active: number; total: number; machines: Set<string> }
  >();

  for (const session of sessions) {
    const name = session.project;
    let entry = projectMap.get(name);
    if (!entry) {
      entry = { active: 0, total: 0, machines: new Set() };
      projectMap.set(name, entry);
    }
    entry.total++;
    if (session.status === "active" || session.status === "idle") {
      entry.active++;
    }
    entry.machines.add(session.machine);
  }

  const projects: Project[] = [];
  for (const [name, entry] of projectMap) {
    projects.push({
      name,
      active_sessions: entry.active,
      total_sessions: entry.total,
      machines: Array.from(entry.machines).sort(),
    });
  }

  // Sort alphabetically by project name
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

// ── Route handler ──────────────────────────────────────────────────────────

/** GET /projects — aggregated project list with session counts and machine lists. */
export async function handleGetProjects(db: Db): Promise<Response> {
  const now = Date.now();
  if (projectsCache && now < projectsCache.expiry) {
    return new Response(JSON.stringify(projectsCache.data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Use a broad window so we include recently ended sessions too
  const sessions = await queryRecentSessions(db, 24 * 30); // 30 days
  const projects = aggregateProjects(sessions);

  projectsCache = { data: projects, expiry: now + PROJECTS_CACHE_TTL_MS };

  return new Response(JSON.stringify(projects), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
