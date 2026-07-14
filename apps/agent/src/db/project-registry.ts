import type { Db } from "@nexus/db";
import { projects, projectLocations } from "@nexus/db";
import { eq, and, notInArray, inArray, or } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:db:project-registry");

export interface ProjectToUpsert {
  name: string;
  path: string; // absolute, tilde-expanded
  activeSessions: number;
  totalSessions: number;
  /** Git remote URL for origin — null when the project has no remote. */
  gitRemoteUrl: string | null;
}

/** A discovered project as stored in the registry, joined to its location. */
export interface RegisteredProject {
  projectId: string;
  name: string;
  /** Absolute filesystem path on the queried agent. */
  path: string;
  agentId: string;
  activeSessions: number;
  totalSessions: number;
}

/**
 * Variant of `RegisteredProject` that includes the sticky-exclude `hidden`
 * flag (agent-payload-completeness). Used by `GET /projects` so the dashboard
 * can surface every registry row — visible and hidden — and apply its own
 * filter, rather than having the agent silently drop hidden rows.
 */
export interface RegisteredProjectWithHidden extends RegisteredProject {
  hidden: boolean;
}

/**
 * List non-hidden, non-archived projects from the registry.
 *
 * Joins `projects` to `project_locations` and filters out:
 *   - rows where the project OR its location is `hidden=true` (sticky exclude)
 *   - locations whose `status` is not `active` (missing/archived are stale)
 *
 * Used by the spec-watcher (registry-first project enumeration) and by
 * `GET /projects` (registry aggregation with hidden filter). Returns `[]` on
 * any error so callers can fall back to their static source.
 */
export async function listRegisteredProjects(db: Db): Promise<RegisteredProject[]> {
  try {
    const rows = await db
      .select({
        projectId: projects.id,
        name: projects.name,
        path: projectLocations.path,
        agentId: projectLocations.agentId,
        activeSessions: projectLocations.activeSessions,
        totalSessions: projectLocations.totalSessions,
      })
      .from(projectLocations)
      .innerJoin(projects, eq(projectLocations.projectId, projects.id))
      .where(
        and(
          eq(projectLocations.status, "active"),
          eq(projectLocations.hidden, false),
          eq(projects.hidden, false),
        ),
      );
    return rows;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "listRegisteredProjects query failed — returning empty",
    );
    return [];
  }
}

/**
 * List all non-archived projects from the registry, INCLUDING hidden rows.
 *
 * Same filter shape as `listRegisteredProjects` but without the `hidden=false`
 * predicates — `GET /projects` (agent-payload-completeness) needs to surface
 * the sticky-exclude flag to the Swift dashboard so the UI can filter rather
 * than the server silently dropping rows. Returns `[]` on error.
 */
export async function listAllRegisteredProjects(
  db: Db,
): Promise<RegisteredProjectWithHidden[]> {
  try {
    const rows = await db
      .select({
        projectId: projects.id,
        name: projects.name,
        path: projectLocations.path,
        agentId: projectLocations.agentId,
        activeSessions: projectLocations.activeSessions,
        totalSessions: projectLocations.totalSessions,
        // Project-level hidden is the canonical sticky-exclude flag; the
        // per-location hidden bit is a finer-grained UI affordance we don't
        // surface in the aggregate row today.
        hidden: projects.hidden,
      })
      .from(projectLocations)
      .innerJoin(projects, eq(projectLocations.projectId, projects.id))
      .where(eq(projectLocations.status, "active"));
    return rows;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "listAllRegisteredProjects query failed — returning empty",
    );
    return [];
  }
}

/**
 * Resolve canonical `projects.id` values for a set of discovered project names.
 *
 * Returns a `name -> projects.id` map for every name that has a matching
 * registry row. Names with no registry row are simply absent from the map, so
 * a caller reads `map.get(name) ?? null` to get the registryId-or-null contract
 * (`close-registry-id-propagation-gap`). Returns an empty map on any error so
 * the discovery path degrades to `registryId: null` rather than failing.
 */
export async function getRegistryIdsByNames(
  db: Db,
  names: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.length === 0) return map;
  try {
    const rows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.name, names));
    for (const r of rows) map.set(r.name, r.id);
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "getRegistryIdsByNames query failed — returning empty map",
    );
  }
  return map;
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
    //
    // STICKY-HIDDEN INVARIANT (folder-based-project-autodiscovery, design.md):
    // `hidden` is intentionally absent from BOTH the insert .values() and the
    // onConflictDoUpdate set-clause. New rows take the column default (false);
    // an existing hidden=true row keeps its value because the set-clause never
    // overwrites it. Re-discovery MUST NOT un-hide a removed project — do NOT
    // add `hidden` here.
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
