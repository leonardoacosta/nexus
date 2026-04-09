import type { CanonicalProject, ProjectLocation } from "@nexus/core";
import { projects, projectLocations, agents } from "@nexus/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sort priority for project locations without an explicit priority. */
export const DEFAULT_PRIORITY = 999;

/**
 * Standard select fields for the projects + locations + agents join.
 * Use this wherever you query canonical projects to keep the field list DRY.
 */
export const PROJECT_SELECT_FIELDS = {
  projectId: projects.id,
  projectName: projects.name,
  primaryAgentId: projects.primaryAgentId,
  discoveredAt: projects.discoveredAt,
  tags: projects.tags,
  description: projects.description,
  locationId: projectLocations.id,
  agentId: projectLocations.agentId,
  agentName: agents.name,
  path: projectLocations.path,
  status: projectLocations.status,
  activeSessions: projectLocations.activeSessions,
  totalSessions: projectLocations.totalSessions,
  priority: projectLocations.priority,
} as const;

// ---------------------------------------------------------------------------
// Row type — inferred from the select fields
// ---------------------------------------------------------------------------

/** Shape of a single row returned by a select using PROJECT_SELECT_FIELDS. */
export interface ProjectJoinRow {
  projectId: string;
  projectName: string;
  primaryAgentId: string;
  discoveredAt: Date | string | null;
  tags: string[] | null;
  description: string | null;
  locationId: string | null;
  agentId: string | null;
  agentName: string | null;
  path: string | null;
  status: string | null;
  activeSessions: number | null;
  totalSessions: number | null;
  priority: number | null;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build a `CanonicalProject[]` from join rows.
 *
 * Groups rows by project ID and accumulates location entries, aggregating
 * session counts. This is the single source of truth for the row-to-
 * CanonicalProject mapping — all callers should use this instead of
 * hand-rolling the grouping logic.
 */
export function buildCanonicalProjects(rows: ProjectJoinRow[]): CanonicalProject[] {
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
        discoveredAt: row.discoveredAt ?? new Date(),
        tags: row.tags ?? null,
        description: row.description ?? null,
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
        priority: row.priority ?? DEFAULT_PRIORITY,
      };
      project.locations.push(location);
      project.activeSessions += location.activeSessions;
      project.totalSessions += location.totalSessions;
    }
  }

  return Array.from(projectMap.values());
}
