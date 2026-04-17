/**
 * Declarative route table for the nexus-agent HTTP API.
 *
 * `buildRoutes` is the public orchestrator: it delegates to per-domain
 * builders under `./routes/` and concatenates their routes in the same
 * order the router expects (method/path pairs must remain stable so the
 * request-dispatch semantics do not change).
 *
 * Handler logic and per-domain builder definitions live in the files
 * under `./routes/*`. This orchestrator stays intentionally thin so new
 * domains can be added by appending a single builder call below.
 *
 * See `apps/agent/src/router.ts` for the `Route` contract and the
 * compile/match semantics (method + path pattern + optional DB/auth flags).
 */

import type { Db } from "@nexus/db";
import type { Route } from "./router";
import type { ServerState } from "./server-websocket";

import { buildHealthRoutes } from "./routes/health";
import { buildSessionsRoutes } from "./routes/sessions-builder";
import { buildProjectsRoutes } from "./routes/projects-builder";
import { buildHealthHistoryRoutes } from "./routes/health-history-builder";
import { buildNotificationsRoutes } from "./routes/notifications-builder";
import { buildCredentialsRoutes } from "./routes/credentials-builder";
import { buildAnalyticsRoutes } from "./routes/analytics-builder";
import { buildOperationalRoutes } from "./routes/operational-builder";
import { buildEventsRoutes, buildEventsStreamRoutes } from "./routes/events-builder";
import { buildProjectDetailRoutes } from "./routes/project-detail-builder";
import { buildSpecsRoutes } from "./routes/specs-builder";
import { buildCommandsRoutes } from "./routes/commands-builder";
import { buildMiscRoutes } from "./routes/misc-builder";

// ---------------------------------------------------------------------------
// Route table factory
// ---------------------------------------------------------------------------

/**
 * Build the full route table.
 *
 * Routes that need the database are flagged with `requiresDb: true` so the
 * router skips them when no DB is configured. The `db` parameter is captured
 * in closures inside each domain builder — it may be undefined at runtime,
 * but the router's DB guard ensures those closures are never invoked
 * without a valid connection.
 *
 * Route ordering: preserves the order of the legacy monolithic builder so
 * any path/method dispatch that relied on declaration order (e.g.
 * /specs/:project/:name/:action ahead of /specs/:project/:name) continues
 * to work identically.
 */
export function buildRoutes(state: ServerState, db?: Db): Route[] {
  return [
    ...buildHealthRoutes(state, db),
    ...buildSessionsRoutes(db),
    ...buildProjectsRoutes(db),
    ...buildHealthHistoryRoutes(db),
    ...buildNotificationsRoutes(db),
    ...buildCredentialsRoutes(db),
    ...buildAnalyticsRoutes(db),
    ...buildOperationalRoutes(db),
    ...buildEventsRoutes(db),
    ...buildProjectDetailRoutes(db),
    ...buildSpecsRoutes(),
    ...buildCommandsRoutes(),
    ...buildMiscRoutes(),
    // /events/stream is declared last (no DB required) to preserve the
    // ordering of the legacy monolithic builder.
    ...buildEventsStreamRoutes(),
  ];
}
