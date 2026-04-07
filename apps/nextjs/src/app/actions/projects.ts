"use server";

import type { CanonicalProject, ProjectLocation } from "@nexus/core";
import { getDb } from "@/lib/db";
import { projects, projectLocations, agents, eq } from "@nexus/db";

export interface TagGroupSummary {
  tag: string;
  activeSessions: number;
  totalSessions: number;
}

export interface ProjectsResult {
  projects: CanonicalProject[];
  tagGroups: TagGroupSummary[];
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
        discoveredAt: row.discoveredAt ?? "",
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

  // Aggregate active/total session counts per tag group.
  const tagGroupMap = new Map<string, TagGroupSummary>();
  for (const project of sorted) {
    const tag = project.tags?.[0] ?? "uncategorized";
    const existing = tagGroupMap.get(tag);
    if (existing) {
      existing.activeSessions += project.activeSessions;
      existing.totalSessions += project.totalSessions;
    } else {
      tagGroupMap.set(tag, {
        tag,
        activeSessions: project.activeSessions,
        totalSessions: project.totalSessions,
      });
    }
  }

  const tagGroups = Array.from(tagGroupMap.values()).sort((a, b) => {
    if (a.tag === "uncategorized") return 1;
    if (b.tag === "uncategorized") return -1;
    return a.tag.localeCompare(b.tag);
  });

  return { projects: sorted, tagGroups };
}

/**
 * Fetch a single canonical project by name.
 * Returns null if not found.
 */
export async function fetchProject(name: string): Promise<CanonicalProject | null> {
  const db = getDb();

  const rows = await db
    .select({
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
    })
    .from(projects)
    .leftJoin(projectLocations, eq(projectLocations.projectId, projects.id))
    .leftJoin(agents, eq(agents.id, projectLocations.agentId))
    .where(eq(projects.name, name));

  if (rows.length === 0) return null;

  const first = rows[0]!;
  const project: CanonicalProject = {
    id: first.projectId,
    name: first.projectName,
    primaryAgentId: first.primaryAgentId,
    locations: [],
    activeSessions: 0,
    totalSessions: 0,
    discoveredAt: first.discoveredAt ?? "",
    tags: first.tags ?? null,
    description: first.description ?? null,
  };

  for (const row of rows) {
    if (row.locationId && row.agentId) {
      const location: ProjectLocation = {
        agentId: row.agentId,
        agentName: row.agentName ?? row.agentId,
        path: row.path ?? "",
        activeSessions: row.activeSessions ?? 0,
        totalSessions: row.totalSessions ?? 0,
        isPrimary: row.agentId === first.primaryAgentId,
        status: (row.status ?? "active") as "active" | "missing" | "archived",
        priority: row.priority ?? 999,
      };
      project.locations.push(location);
      project.activeSessions += location.activeSessions;
      project.totalSessions += location.totalSessions;
    }
  }

  return project;
}

/**
 * Update mutable metadata fields on a project.
 * Tags are normalized to trimmed lowercase before writing.
 */
export async function updateProject(
  id: string,
  data: { tags?: string[]; description?: string },
): Promise<void> {
  const db = getDb();

  const patch: { tags?: string[]; description?: string } = {};
  if (data.tags !== undefined) {
    patch.tags = data.tags.map((t) => t.trim().toLowerCase());
  }
  if (data.description !== undefined) {
    patch.description = data.description;
  }

  if (Object.keys(patch).length === 0) return;

  await db.update(projects).set(patch).where(eq(projects.id, id));
}
