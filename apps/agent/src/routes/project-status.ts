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
import { projectStatusSnapshots } from "@nexus/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { logger } from "@nexus/core/node";
import type {
  ProjectStatusHistoryResponse,
  ProjectStatusLatestResponse,
  ProjectStatusSnapshot,
} from "@nexus/core";
import { getProjects } from "../services/config-loader";
import { withCors } from "../server-origin";

// Mirrors `db/retention.ts`'s PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS (same env
// var + default) so a `?history` request is capped at the window retention
// actually keeps — asking for more days than are retained returns only what
// exists, never a promise of pruned rows.
const RETENTION_DAYS = Number(
  process.env.PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS ?? "90",
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

  const body: ProjectStatusLatestResponse = toWire(row);
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
