import type { Db } from "@nexus/db";
import type { Project } from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import { projects as projectsTable, eq } from "@nexus/db";
import { queryRecentSessions } from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { listRegisteredProjects } from "../db/project-registry";
import { encodeCursor, parseCursor, parseLimit } from "./cursor";

const log = createLogger("agent:routes:projects");

// ── Pagination constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

interface SessionAgg {
  active: number;
  total: number;
  machines: Set<string>;
}

/**
 * Bucket sessions by `projectId` (null → the `(unregistered)` sentinel key).
 *
 * Kept as a map so the registry merge can overlay session counts onto a
 * registered project by id, and any session-only bucket with no registry row
 * still surfaces (preserves the legacy session-derived behaviour).
 */
function bucketSessions(sessions: SessionRow[]): Map<string, SessionAgg> {
  const UNREGISTERED = "(unregistered)";
  const map = new Map<string, SessionAgg>();
  for (const session of sessions) {
    const key = session.projectId ?? UNREGISTERED;
    let entry = map.get(key);
    if (!entry) {
      entry = { active: 0, total: 0, machines: new Set() };
      map.set(key, entry);
    }
    entry.total++;
    if (session.status === "active" || session.status === "idle") {
      entry.active++;
    }
    entry.machines.add(session.machine);
  }
  return map;
}

/**
 * Aggregate the project list from the registry (hidden already excluded by
 * `listRegisteredProjects`), overlaying live session counts by projectId.
 *
 * Registry rows give friendly names + always appear even with zero sessions
 * (fixes the "all (unregistered)" symptom). Session-only buckets with no
 * matching registry id (e.g. `(unregistered)`, or a project not yet scanned)
 * are still emitted so the legacy session-derived behaviour never regresses.
 */
function aggregateProjects(
  sessions: SessionRow[],
  registered: { projectId: string; name: string }[],
): Project[] {
  const sessionBuckets = bucketSessions(sessions);
  const projects: Project[] = [];
  const consumedKeys = new Set<string>();

  // 1. Registry-driven rows — named, hidden-filtered, zero-session-safe.
  for (const reg of registered) {
    const agg = sessionBuckets.get(reg.projectId);
    if (agg) consumedKeys.add(reg.projectId);
    projects.push({
      name: reg.name,
      active_sessions: agg?.active ?? 0,
      total_sessions: agg?.total ?? 0,
      machines: agg ? Array.from(agg.machines).sort() : [],
    });
  }

  // 2. Session-only buckets with no registry row (fallback — never regress).
  for (const [key, agg] of sessionBuckets) {
    if (consumedKeys.has(key)) continue;
    projects.push({
      name: key,
      active_sessions: agg.active,
      total_sessions: agg.total,
      machines: Array.from(agg.machines).sort(),
    });
  }

  // Sort alphabetically by project name (stable paginate key)
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

// ── Paginated response shape (cursor callers) ──────────────────────────────

/** Paginated response for GET /projects when cursor/limit is supplied. */
export interface ProjectListResponse {
  items: Project[];
  nextCursor: string | null;
}

// ── Route handler ──────────────────────────────────────────────────────────

/**
 * GET /projects — aggregated project list with session counts and machine lists.
 *
 * Pagination:
 * - No `cursor` and no `limit` query params: legacy behavior — returns a bare
 *   `Project[]` array with every project.
 * - `cursor` or `limit` present: returns `{ items, nextCursor }` where the
 *   opaque `nextCursor` is a base64-encoded marker (internally the last-seen
 *   project name; callers MUST treat it as opaque).
 *
 * Invalid cursors produce a 400 response without leaking the encoding format.
 * `limit` is silently clamped to [1, 200]; default is 50.
 *
 * NOTE: The `Project` type aggregates sessions by project name/id and has no
 * standalone UUID — the cursor marker is the sort key (`name`). If a future
 * change adds a UUID primary key on the aggregated row, switch the cursor
 * marker to that UUID without changing the wire-level cursor format.
 */
export async function handleGetProjects(db: Db, url?: URL): Promise<Response> {
  const start = Date.now();
  const route = "/projects";
  const now = Date.now();

  const rawCursor = url?.searchParams.get("cursor") ?? null;
  const rawLimit = url?.searchParams.get("limit") ?? null;
  const paginated = rawCursor !== null || rawLimit !== null;

  // Validate cursor early so malformed input fails before any DB work.
  let cursorMarker: string | null = null;
  if (rawCursor !== null) {
    cursorMarker = parseCursor(rawCursor);
    if (cursorMarker === null) {
      log.info({ route }, "rejected request with invalid cursor");
      return new Response(
        JSON.stringify({ error: "invalid cursor" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Warn when the caller-supplied limit exceeded the max and was clamped.
  const limit = parseLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
  if (rawLimit !== null) {
    const requested = Number(rawLimit);
    if (Number.isFinite(requested) && requested > MAX_LIMIT) {
      log.warn(
        { route, requested, clampedTo: MAX_LIMIT },
        "limit exceeded max — clamped",
      );
    }
  }

  let projects: Project[];
  if (projectsCache && now < projectsCache.expiry) {
    projects = projectsCache.data;
    log.info(
      { route, count: projects.length, fromCache: true, paginated },
      "projects request (cache hit)",
    );
  } else {
    // Use a broad window so we include recently ended sessions too
    const sessions = await queryRecentSessions(db, 24 * 30); // 30 days
    // listRegisteredProjects already excludes hidden projects/locations.
    const registered = await listRegisteredProjects(db);
    projects = aggregateProjects(sessions, registered);
    projectsCache = { data: projects, expiry: now + PROJECTS_CACHE_TTL_MS };
    log.info(
      { route, count: projects.length, fromCache: false, paginated },
      "projects request",
    );
  }

  // Legacy callers (no cursor/limit) get the full array verbatim.
  if (!paginated) {
    const durationMs = Date.now() - start;
    log.info({ route, durationMs, count: projects.length }, "legacy shape served");
    return new Response(JSON.stringify(projects), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Paginated shape: slice starting after the cursor marker (exclusive) and
  // cap at `limit` items. `nextCursor` is the last emitted item's name when
  // more rows remain, else null.
  const filtered = cursorMarker !== null
    ? projects.filter((p) => p.name > cursorMarker!)
    : projects;

  const page = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit && page.length > 0
      ? encodeCursor(page[page.length - 1]!.name)
      : null;

  const body: ProjectListResponse = { items: page, nextCursor };

  const durationMs = Date.now() - start;
  log.info(
    { route, durationMs, pageSize: page.length, hasNextCursor: nextCursor !== null },
    "paginated shape served",
  );

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── PATCH /projects/:id ────────────────────────────────────────────────────

/**
 * PATCH /projects/:id — update mutable metadata on a project.
 *
 * Allowed fields: `tags` (string[]), `description` (string), `hidden` (boolean).
 * Tags are normalized to trimmed lowercase before writing. Setting
 * `hidden=true` removes the project from `GET /projects`; the auto-discovery
 * scanner preserves it (sticky exclude) so a re-scan won't resurrect it.
 *
 * Returns 200 `{ updated: true }` on success, 400 on bad input, 404 if not found.
 */
export async function handleUpdateProject(
  db: Db,
  id: string,
  request: Request,
): Promise<Response> {
  // Validate UUID format — reject obviously bad IDs before any DB work.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return new Response(
      JSON.stringify({ error: "invalid project id format" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: { tags?: unknown; description?: unknown; hidden?: unknown };
  try {
    body = (await request.json()) as {
      tags?: unknown;
      description?: unknown;
      hidden?: unknown;
    };
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const patch: { tags?: string[]; description?: string; hidden?: boolean } = {};

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
      return new Response(
        JSON.stringify({ error: "tags must be an array of strings" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    patch.tags = (body.tags as string[]).map((t) => t.trim().toLowerCase());
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return new Response(
        JSON.stringify({ error: "description must be a string" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    patch.description = body.description;
  }

  if (body.hidden !== undefined) {
    if (typeof body.hidden !== "boolean") {
      return new Response(
        JSON.stringify({ error: "hidden must be a boolean" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    patch.hidden = body.hidden;
  }

  if (Object.keys(patch).length === 0) {
    return new Response(
      JSON.stringify({ error: "no updatable fields provided" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Verify project exists before updating.
  const existing = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.id, id))
    .limit(1);

  if (existing.length === 0) {
    return new Response(
      JSON.stringify({ error: "project not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  await db.update(projectsTable).set(patch).where(eq(projectsTable.id, id));

  log.info(
    { route: "/projects/:id", projectId: id, fields: Object.keys(patch) },
    body.hidden !== undefined
      ? `project ${id} hidden flag set to ${String(patch.hidden)}`
      : `project ${id} metadata updated`,
  );

  return new Response(
    JSON.stringify({ updated: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
