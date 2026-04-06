"use server";

import type { CanonicalProject, ProjectLocation } from "@nexus/core";
import { getDb } from "@/lib/db";
import { projects, projectLocations, agents, eq } from "@nexus/db";

export interface ProjectsResult {
  projects: CanonicalProject[];
}

/**
 * Fetch all active projects from the DB, grouped into CanonicalProject[].
 * Sorted by active session count descending, then alphabetically.
 */
export async function fetchProjects(): Promise<ProjectsResult> {
  const db = getDb();

  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      primaryAgentId: projects.primaryAgentId,
      discoveredAt: projects.discoveredAt,
      locationId: projectLocations.id,
      agentId: projectLocations.agentId,
      agentName: agents.name,
      path: projectLocations.path,
      status: projectLocations.status,
      activeSessions: projectLocations.activeSessions,
      totalSessions: projectLocations.totalSessions,
      priority: projectLocations.priority,
    })
    .from(projects)
    .leftJoin(projectLocations, eq(projectLocations.projectId, projects.id))
    .leftJoin(agents, eq(agents.id, projectLocations.agentId))
    .where(eq(projects.status, "active"));

  const projectMap = new Map<string, CanonicalProject>();

  for (const row of rows) {
    if (!projectMap.has(row.projectId)) {
      projectMap.set(row.projectId, {
        id: row.projectId,
        name: row.projectName,
        primaryAgentId: row.primaryAgentId,
        locations: [],
        activeSessions: 0,
        totalSessions: 0,
        discoveredAt: row.discoveredAt ?? new Date().toISOString(),
      });
    }

    const project = projectMap.get(row.projectId)!;

    if (row.locationId && row.agentId) {
      const location: ProjectLocation = {
        agentId: row.agentId,
        agentName: row.agentName ?? row.agentId,
        path: row.path ?? "",
        activeSessions: row.activeSessions ?? 0,
        totalSessions: row.totalSessions ?? 0,
        isPrimary: row.agentId === row.primaryAgentId,
        status: (row.status ?? "active") as "active" | "missing" | "archived",
        priority: row.priority ?? 999,
      };
      project.locations.push(location);
      project.activeSessions += location.activeSessions;
      project.totalSessions += location.totalSessions;
    }
  }

  const sorted = Array.from(projectMap.values()).sort((a, b) => {
    if (b.activeSessions !== a.activeSessions) return b.activeSessions - a.activeSessions;
    return a.name.localeCompare(b.name);
  });

  return { projects: sorted };
}
