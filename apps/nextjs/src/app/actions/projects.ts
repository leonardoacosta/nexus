"use server";

import { revalidatePath } from "next/cache";
import type { CanonicalProject } from "@nexus/core";
import { getDb } from "@/lib/db";
import { projects, projectLocations, agents, eq } from "@nexus/db";
import { PROJECT_SELECT_FIELDS, buildCanonicalProjects } from "@/lib/projects";
import { getClient } from "@/lib/get-client";

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
 *
 * Delegates to the agent HTTP API (PATCH /projects/:id) so that
 * apps/nextjs never writes directly to the DB.
 *
 * `name` is required for RSC cache invalidation — it maps to the
 * `/projects/[name]` route segment. Pass `project.name` from the caller.
 */
export async function updateProject(
  id: string,
  data: { tags?: string[]; description?: string; name?: string },
): Promise<void> {
  const { name, ...rest } = data;
  const patch: { tags?: string[]; description?: string } = {};
  if (rest.tags !== undefined) {
    patch.tags = rest.tags.map((t) => t.trim().toLowerCase());
  }
  if (rest.description !== undefined) {
    patch.description = rest.description;
  }

  if (Object.keys(patch).length === 0) return;

  const client = await getClient();
  await client.updateProject({ id, ...patch });

  revalidatePath("/projects");
  if (name) {
    revalidatePath(`/projects/${encodeURIComponent(name)}`);
  }
}
