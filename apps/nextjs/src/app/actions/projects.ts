"use server";

import type { CanonicalProject } from "@nexus/core";
import { getDb } from "@/lib/db";
import { projects, projectLocations, agents, eq } from "@nexus/db";
import { PROJECT_SELECT_FIELDS, buildCanonicalProjects } from "@/lib/projects";

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
    .select(PROJECT_SELECT_FIELDS)
    .from(projects)
    .leftJoin(projectLocations, eq(projectLocations.projectId, projects.id))
    .leftJoin(agents, eq(agents.id, projectLocations.agentId))
    .where(eq(projects.status, "active"));

  const sorted = buildCanonicalProjects(rows).sort((a, b) => {
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
    .select(PROJECT_SELECT_FIELDS)
    .from(projects)
    .leftJoin(projectLocations, eq(projectLocations.projectId, projects.id))
    .leftJoin(agents, eq(agents.id, projectLocations.agentId))
    .where(eq(projects.name, name));

  if (rows.length === 0) return null;

  const results = buildCanonicalProjects(rows);
  return results[0] ?? null;
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
