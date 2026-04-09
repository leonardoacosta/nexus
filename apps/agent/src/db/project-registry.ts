import type { Db } from "@nexus/db";
import { projects, projectLocations } from "@nexus/db";
import { eq, and, notInArray, inArray, or } from "drizzle-orm";
import { createLogger } from "@nexus/core";

const log = createLogger("agent:db:project-registry");

export interface ProjectToUpsert {
  name: string;
  path: string; // absolute, tilde-expanded
  activeSessions: number;
  totalSessions: number;
  /** Git remote URL for origin — null when the project has no remote. */
  gitRemoteUrl: string | null;
}

export async function upsertProjectLocations(
  db: Db,
  agentId: string,
  discovered: ProjectToUpsert[],
): Promise<void> {
  if (discovered.length === 0) return;

  for (const p of discovered) {
    // 1. Upsert canonical project — first writer wins for primary_agent_id.
    await db
      .insert(projects)
      .values({
        name: p.name,
        gitRemoteUrl: p.gitRemoteUrl ?? null,
        primaryAgentId: agentId,
        status: "active",
      })
      .onConflictDoNothing();

    // 2. Get the project id — retry once to handle concurrent upsert races.
    let [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, p.name))
      .limit(1);

    if (!project) {
      // Retry: another agent may have inserted between our insert and select.
      [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.name, p.name))
        .limit(1);
    }

    if (!project) {
      log.warn({ name: p.name }, "project not found after upsert (both attempts) — skipping location");
      continue;
    }

    // 3. Determine priority: 1 if this agent is primary, 999 otherwise.
    const [existing] = await db
      .select({ primaryAgentId: projects.primaryAgentId })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1);
    const priority = existing?.primaryAgentId === agentId ? 1 : 999;

    // 4. Upsert location for this agent — persist git_remote_url.
    await db
      .insert(projectLocations)
      .values({
        projectId: project.id,
        agentId,
        path: p.path,
        gitRemoteUrl: p.gitRemoteUrl ?? null,
        status: "active",
        activeSessions: p.activeSessions,
        totalSessions: p.totalSessions,
        lastDiscoveredAt: new Date(),
        priority,
      })
      .onConflictDoUpdate({
        target: [projectLocations.projectId, projectLocations.agentId],
        set: {
          path: p.path,
          gitRemoteUrl: p.gitRemoteUrl ?? null,
          status: "active",
          activeSessions: p.activeSessions,
          totalSessions: p.totalSessions,
          lastDiscoveredAt: new Date(),
        },
      });
  }

  // 5. Mark missing: locations for this agent that weren't in the current scan.
  const discoveredNames = discovered.map((p) => p.name);

  // Get IDs of projects we just discovered.
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
    // No projects discovered — mark all this agent's locations as missing.
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

/**
 * Delete project_locations rows where status='missing' and last_discovered_at
 * is older than 30 days, then archive project rows that have no remaining
 * active or missing locations.
 */
export async function cleanupStaleProjectLocations(db: Db): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);

  // Step 1: Find missing locations older than 30 days.
  const staleLocations = await db
    .select({
      id: projectLocations.id,
      projectId: projectLocations.projectId,
      lastDiscoveredAt: projectLocations.lastDiscoveredAt,
    })
    .from(projectLocations)
    .where(eq(projectLocations.status, "missing"));

  const staleToArchive = staleLocations.filter(
    (r) => !r.lastDiscoveredAt || r.lastDiscoveredAt < thirtyDaysAgo,
  );

  if (staleToArchive.length === 0) {
    log.info("cleanup: no stale project locations to archive");
    return;
  }

  const staleLocationIds = staleToArchive.map((r) => r.id);
  const affectedProjectIds = [...new Set(staleToArchive.map((r) => r.projectId))];

  // Step 2: Archive stale locations.
  await db
    .update(projectLocations)
    .set({ status: "archived" })
    .where(inArray(projectLocations.id, staleLocationIds));

  log.info({ count: staleLocationIds.length }, "cleanup: archived stale project locations");

  // Step 3: Archive project rows that have no remaining active or missing locations.
  for (const projectId of affectedProjectIds) {
    const alive = await db
      .select({ id: projectLocations.id })
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.projectId, projectId),
          or(
            eq(projectLocations.status, "active"),
            eq(projectLocations.status, "missing"),
          ),
        ),
      );

    if (alive.length === 0) {
      await db
        .update(projects)
        .set({ status: "archived" })
        .where(eq(projects.id, projectId));

      log.info({ projectId }, "cleanup: archived project with no remaining active/missing locations");
    }
  }
}

/**
 * Schedule the stale project cleanup job.
 * Runs once at boot, then every 24 hours.
 * Returns a stop function.
 */
export function scheduleProjectCleanup(db: Db): () => void {
  const INTERVAL_MS = 24 * 60 * 60 * 1_000;

  // Run immediately at startup.
  cleanupStaleProjectLocations(db).catch((err) => {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, "project cleanup failed (startup)");
  });

  const handle = setInterval(() => {
    cleanupStaleProjectLocations(db).catch((err) => {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, "project cleanup failed (scheduled)");
    });
  }, INTERVAL_MS);

  return () => clearInterval(handle);
}
