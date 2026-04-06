import type { Db } from "@nexus/db";
import { projects, projectLocations } from "@nexus/db";
import { eq, and, notInArray, inArray } from "drizzle-orm";
import { createLogger } from "@nexus/core";

const log = createLogger("agent:db:project-registry");

export interface ProjectToUpsert {
  name: string;
  path: string; // absolute, tilde-expanded
  activeSessions: number;
  totalSessions: number;
}

export async function upsertProjectLocations(
  db: Db,
  agentId: string,
  discovered: ProjectToUpsert[],
): Promise<void> {
  if (discovered.length === 0) return;

  for (const p of discovered) {
    // 1. Upsert canonical project — first writer wins for primary_agent_id
    await db
      .insert(projects)
      .values({
        name: p.name,
        primaryAgentId: agentId,
        status: "active",
      })
      .onConflictDoNothing({ target: projects.name });

    // 2. Get the project id
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, p.name))
      .limit(1);

    if (!project) {
      log.warn({ name: p.name }, "project not found after upsert — skipping location");
      continue;
    }

    // 3. Determine priority: 1 if this agent is primary, 999 otherwise
    const [existing] = await db
      .select({ primaryAgentId: projects.primaryAgentId })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1);
    const priority = existing?.primaryAgentId === agentId ? 1 : 999;

    // 4. Upsert location for this agent
    await db
      .insert(projectLocations)
      .values({
        projectId: project.id,
        agentId,
        path: p.path,
        status: "active",
        activeSessions: p.activeSessions,
        totalSessions: p.totalSessions,
        lastDiscoveredAt: new Date().toISOString(),
        priority,
      })
      .onConflictDoUpdate({
        target: [projectLocations.projectId, projectLocations.agentId],
        set: {
          path: p.path,
          status: "active",
          activeSessions: p.activeSessions,
          totalSessions: p.totalSessions,
          lastDiscoveredAt: new Date().toISOString(),
        },
      });
  }

  // 5. Mark missing: locations for this agent that weren't in the current scan
  const discoveredNames = discovered.map((p) => p.name);

  // Get IDs of projects we just discovered
  const discoveredProjectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.name, discoveredNames));

  const discoveredProjectIds = discoveredProjectRows.map((r) => r.id);

  if (discoveredProjectIds.length > 0) {
    await db
      .update(projectLocations)
      .set({ status: "missing" })
      .where(
        and(
          eq(projectLocations.agentId, agentId),
          eq(projectLocations.status, "active"),
          notInArray(projectLocations.projectId, discoveredProjectIds),
        ),
      );
  } else {
    // No projects discovered — mark all this agent's locations as missing
    await db
      .update(projectLocations)
      .set({ status: "missing" })
      .where(
        and(
          eq(projectLocations.agentId, agentId),
          eq(projectLocations.status, "active"),
        ),
      );
  }
}
