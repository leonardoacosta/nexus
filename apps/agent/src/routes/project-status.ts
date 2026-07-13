/**
 * GET /projects/:id/status[?history=<days>]
 *
 * Serves the per-project status time-series persisted by
 * `services/status-snapshots.ts` into `project_status_snapshots`:
 *   - no `?history`      -> the single latest snapshot (`projectStatusLatestResponse`)
 *   - `?history=<days>`  -> the series within the window, oldest-first
 *                           (`projectStatusHistoryResponse`), capped at the
 *                           retention window so a caller cannot ask for rows
 *                           that retention has already pruned.
 *
 * `:id` is the project CODE (the `project` text column), consistent with the
 * watcher keying — deliberately not the `projects` uuid. An unregistered
 * project is 404 BEFORE any DB access; a registered project with no snapshots
 * yet is 404 for the latest shape and `[]` for the history shape.
 *
 * Registered via the same `tryHandle*` delegation + `LEGACY_DISPATCH_ROUTES`
 * entry as the session-context routes (add-session-context-api).
 *
 * Spec: openspec/changes/add-project-status-snapshots/ (spec-timeseries delta,
 * ADDED — serving).
 */

import type { Db } from "@nexus/db";
import { gitEvents, projectStatusSnapshots } from "@nexus/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { logger } from "@nexus/core/node";
import type {
  GitEventRecord,
  GitEventsResponse,
  GitStatusObject,
  ProjectStatusHistoryResponse,
  ProjectStatusLatestResponse,
  ProjectStatusSnapshot,
} from "@nexus/core";
import { getProjects } from "../services/config-loader";
import { getObservedGitState } from "../services/git-observer";
import { withCors } from "../server-origin";

/**
 * The `GET /projects/:id/status` latest response with the observer's current
 * git state folded in as an optional `git` field (omitted when the project has
 * not been observed on this agent). The base snapshot shape is owned by
 * add-project-status-snapshots; add-git-status-orbit only ADDs the git field.
 */
type ProjectStatusLatestWithGit = ProjectStatusLatestResponse & {
  git?: GitStatusObject;
};

// Mirrors `db/retention.ts`'s PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS (same env
// var + default) so a `?history` request is capped at the window retention
// actually keeps — asking for more days than are retained returns only what
// exists, never a promise of pruned rows.
const RETENTION_DAYS = Number(
  process.env.PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS ?? "90",
);

// Mirrors `db/retention.ts`'s GIT_EVENTS_RETENTION_DAYS (same env var + default)
// so a `?days` request is capped at the window retention actually keeps.
const GIT_EVENTS_RETENTION_DAYS = Number(
  process.env.GIT_EVENTS_RETENTION_DAYS ?? "90",
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Map a DB row to the camelCase wire shape (timestamp -> ISO 8601). */
function toWire(row: {
  project: string;
  proposalsUnarchived: number;
  beadsReadyUnlinked: number;
  beadsBlockedUnlinked: number;
  createdAt: Date;
}): ProjectStatusSnapshot {
  return {
    project: row.project,
    proposalsUnarchived: row.proposalsUnarchived,
    beadsReadyUnlinked: row.beadsReadyUnlinked,
    beadsBlockedUnlinked: row.beadsBlockedUnlinked,
    createdAt: row.createdAt.toISOString(),
  };
}

function isKnownProject(code: string): boolean {
  return getProjects().some((p) => p.code === code);
}

/**
 * GET /projects/:id/status — latest snapshot, or 404 when the project has no
 * snapshot rows yet.
 */
async function handleGetLatest(db: Db, code: string): Promise<Response> {
  const [row] = await db
    .select()
    .from(projectStatusSnapshots)
    .where(eq(projectStatusSnapshots.project, code))
    .orderBy(desc(projectStatusSnapshots.createdAt))
    .limit(1);

  if (!row) {
    return jsonResponse({ error: "no status data for project" }, 404);
  }

  // Fold the observer's current git state into the payload when the project has
  // been observed on this agent; omit the field entirely otherwise (never a
  // stale/empty git object).
  const git = getObservedGitState(code);
  const body: ProjectStatusLatestWithGit = git
    ? { ...toWire(row), git }
    : toWire(row);
  return jsonResponse(body);
}

/** Map a `git_events` row to the camelCase wire shape (timestamp -> ISO 8601). */
function toGitEventWire(row: {
  eventType: string;
  fromRef: string | null;
  toRef: string | null;
  sha: string | null;
  createdAt: Date;
}): GitEventRecord {
  return {
    eventType: row.eventType,
    fromRef: row.fromRef,
    toRef: row.toRef,
    sha: row.sha,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /projects/:id/git-events?days=<n> — persisted git transitions within the
 * (retention-capped) window, ordered oldest-first. Returns `[]` when there are
 * none. Unknown-project 404 is handled by the dispatcher before this runs.
 */
async function handleGetGitEvents(
  db: Db,
  code: string,
  daysParam: string | null,
): Promise<Response> {
  const requested = daysParam !== null ? Number(daysParam) : NaN;
  const days =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, GIT_EVENTS_RETENTION_DAYS)
      : GIT_EVENTS_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const rows = await db
    .select()
    .from(gitEvents)
    .where(and(eq(gitEvents.project, code), gte(gitEvents.createdAt, cutoff)))
    .orderBy(asc(gitEvents.createdAt));

  const body: GitEventsResponse = rows.map(toGitEventWire);
  return jsonResponse(body);
}

/**
 * GET /projects/:id/status?history=<days> — snapshots within the (retention-
 * capped) window, ordered oldest-first. Returns `[]` when there are none.
 */
async function handleGetHistory(
  db: Db,
  code: string,
  historyParam: string,
): Promise<Response> {
  const requested = Number(historyParam);
  const days =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, RETENTION_DAYS)
      : RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const rows = await db
    .select()
    .from(projectStatusSnapshots)
    .where(
      and(
        eq(projectStatusSnapshots.project, code),
        gte(projectStatusSnapshots.createdAt, cutoff),
      ),
    )
    .orderBy(asc(projectStatusSnapshots.createdAt));

  const body: ProjectStatusHistoryResponse = rows.map(toWire);
  return jsonResponse(body);
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Match and handle `GET /projects/:id/status`. Returns a Response when the URL
 * matches, or `null` when it does not (callers fall through).
 *
 * Dispatched inside the `if (db)` block of `server-request-handler.ts`; there
 * is no `/projects/:id` GET catch-all that could swallow this (the only sibling
 * `/projects/:id` route is a PATCH), but this dispatcher's precise 4-segment
 * match keeps it collision-proof regardless of future additions.
 */
export function tryHandleProjectStatusRoute(
  request: Request,
  url: URL,
  db: Db,
): Promise<Response> | null {
  // ["", "projects", ":id", "status"]
  const segments = url.pathname.split("/");
  if (
    segments.length !== 4 ||
    segments[1] !== "projects" ||
    segments[3] !== "status"
  ) {
    return null;
  }
  const code = segments[2];
  if (!code || request.method !== "GET") return null;

  const route = `/projects/${code}/status`;
  const wrap = (p: Promise<Response>): Promise<Response> =>
    p
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error({ route, method: "GET", err }, "route handler failed");
        return withCors(request, jsonResponse({ error: "internal error" }, 500));
      });

  if (!isKnownProject(code)) {
    return wrap(Promise.resolve(jsonResponse({ error: `unknown project: ${code}` }, 404)));
  }

  const historyParam = url.searchParams.get("history");
  return wrap(
    historyParam !== null
      ? handleGetHistory(db, code, historyParam)
      : handleGetLatest(db, code),
  );
}

/**
 * Match and handle `GET /projects/:id/git-events[?days=<n>]`. Returns a
 * Response when the URL matches, or `null` when it does not (callers fall
 * through). Same 4-segment precise-match shape as the status dispatcher —
 * `segments[3] === "git-events"` cannot collide with the `status` route or the
 * PATCH `/projects/:id` sibling. Unknown project is 404 before any DB access.
 *
 * Spec: openspec/changes/add-git-status-orbit/ (git-event-store delta — serving).
 */
export function tryHandleGitEventsRoute(
  request: Request,
  url: URL,
  db: Db,
): Promise<Response> | null {
  // ["", "projects", ":id", "git-events"]
  const segments = url.pathname.split("/");
  if (
    segments.length !== 4 ||
    segments[1] !== "projects" ||
    segments[3] !== "git-events"
  ) {
    return null;
  }
  const code = segments[2];
  if (!code || request.method !== "GET") return null;

  const route = `/projects/${code}/git-events`;
  const wrap = (p: Promise<Response>): Promise<Response> =>
    p
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error({ route, method: "GET", err }, "route handler failed");
        return withCors(request, jsonResponse({ error: "internal error" }, 500));
      });

  if (!isKnownProject(code)) {
    return wrap(Promise.resolve(jsonResponse({ error: `unknown project: ${code}` }, 404)));
  }

  const daysParam = url.searchParams.get("days");
  return wrap(handleGetGitEvents(db, code, daysParam));
}
