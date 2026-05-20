/**
 * HTTP request dispatcher extracted from server.ts.
 *
 * Encapsulates:
 * - WebSocket upgrade delegation
 * - CORS preflight handling
 * - Origin defense-in-depth (403 block for non-Tailscale browser origins)
 * - Credential ID pre-validation for path-parameterised credential routes
 * - Route dispatch for every HTTP route served by nexus-agent
 *
 * Route-group sub-dispatchers live in:
 * - server-routes-credentials.ts — /credentials/*
 * - server-routes-specs.ts       — /specs/*, /commands/*
 */

import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import {
  handleGetSessions,
  handleGetSessionById,
  handleSessionStart,
  handleSessionsProbe,
} from "./routes/sessions";
import { handleGetProjects, handleUpdateProject } from "./routes/projects";
import { handleSaveAgent, handleDeleteAgent } from "./routes/settings";
import { handleGetAgentSelf } from "./routes/agent-self";
import { handleGetDiscoveredProjects } from "./routes/projects-discovered";
import { handleGetHealthHistory } from "./routes/health-history";
import {
  handleSendNotification,
  handleListNotifications,
  handleMeetingStart,
  handleMeetingEnd,
  handleMeetingStatus,
} from "./routes/notifications";
import {
  handleGetNotificationSettings,
  handlePatchNotificationSettings,
} from "./routes/notification-settings";
import {
  handleAnalyticsHealth,
  handleAnalyticsSpecs,
  handleAnalyticsCredentials,
  handleAnalyticsGit,
  handleAnalyticsLifecycle,
  handleAnalyticsCron,
} from "./routes/analytics";
import {
  handleProjectStatus,
  handleProjectBeads,
  handleProjectGit,
  handleProjectSpecs,
  handleRunCommand,
} from "./routes/project-detail";
import { handleStatusline } from "./routes/statusline";
import { handleRecommend } from "./routes/recommend";
import { handleEnvironment } from "./routes/environment-route";
import { handleFailures } from "./routes/failures-route";
import { handleCron } from "./routes/cron-routes";
import { handleGetEvents, handleEventsStream } from "./routes/events-sse";
import type { WsData } from "./terminal/stream-manager";
import { ServerState, handleWsUpgrade } from "./server-websocket";
import { isDisallowedBrowserOrigin, withCors } from "./server-origin";
import { CREDENTIAL_ID_RE } from "./server-auth";
import { handleHealthGet, handleHealthIngest } from "./server-health-handler";
import { tryHandleCredentialRoute } from "./server-routes-credentials";
import { tryHandleSpecRoute, tryHandleCommandRoute } from "./server-routes-specs";
import { buildVersionRoutes, type Route } from "./routes/version-builder";

/**
 * Source-of-truth list of dispatch routes for /version capability reporting.
 *
 * MUST be kept in sync with the if/else dispatch chain in `handleRequest`
 * below. Adding a new route to the dispatcher? Add it here too.
 *
 * This is a temporary contract until the legacy dispatcher is migrated to
 * the typed route table in routes.ts. The typed table in routes.ts is built
 * but NOT dispatched — the actual API surface comes from the if/else chain
 * in this file. See follow-up bead nx-* for the migration plan.
 *
 * Path-parameterised routes use `:id`-style placeholders to mirror how the
 * typed route table declares them. Where a route group is delegated to a
 * sub-dispatcher (e.g. /credentials/*, /specs/*), the concrete paths
 * served are listed here so the capabilities array reflects the real API.
 */
const LEGACY_DISPATCH_ROUTES: Pick<Route, "method" | "path">[] = [
  // Health
  { method: "GET", path: "/health" },
  { method: "POST", path: "/health/ingest" },
  { method: "GET", path: "/health/history" },
  // Sessions
  { method: "GET", path: "/sessions" },
  { method: "GET", path: "/sessions/:id" },
  { method: "POST", path: "/session/start" },
  { method: "POST", path: "/sessions/probe" },
  // Projects
  { method: "GET", path: "/projects" },
  { method: "PATCH", path: "/projects/:id" },
  { method: "GET", path: "/projects/discovered" },
  // Notifications (the route that triggered this whole spec)
  { method: "POST", path: "/notifications/send" },
  { method: "GET", path: "/notifications" },
  { method: "GET", path: "/notifications/settings" },
  { method: "PATCH", path: "/notifications/settings" },
  { method: "POST", path: "/meeting/start" },
  { method: "POST", path: "/meeting/end" },
  { method: "GET", path: "/meeting/status" },
  // Credentials (delegated to server-routes-credentials.ts)
  { method: "GET", path: "/credentials" },
  { method: "POST", path: "/credentials" },
  { method: "GET", path: "/credentials/active" },
  { method: "POST", path: "/credentials/lease" },
  { method: "POST", path: "/credentials/:id/release" },
  { method: "POST", path: "/credentials/:id/report-rate-limit" },
  { method: "GET", path: "/credentials/:id/health" },
  { method: "GET", path: "/credentials/status" },
  // Agents (settings)
  { method: "GET", path: "/agent/self" },
  { method: "POST", path: "/agents" },
  { method: "DELETE", path: "/agents/:id" },
  // Analytics
  { method: "GET", path: "/analytics/health" },
  { method: "GET", path: "/analytics/specs" },
  { method: "GET", path: "/analytics/credentials" },
  { method: "GET", path: "/analytics/git" },
  { method: "GET", path: "/analytics/lifecycle" },
  { method: "GET", path: "/analytics/cron" },
  // Operational
  { method: "GET", path: "/statusline" },
  { method: "POST", path: "/hooks" },
  { method: "GET", path: "/recommend" },
  { method: "GET", path: "/environment" },
  { method: "GET", path: "/failures" },
  { method: "GET", path: "/cron" },
  // Project detail
  { method: "GET", path: "/project/:code/status" },
  { method: "GET", path: "/project/:code/beads" },
  { method: "GET", path: "/project/:code/git" },
  { method: "GET", path: "/project/:code/specs" },
  { method: "POST", path: "/project/:code/run" },
  // Spec content (dashboard-ui-pass-v1)
  { method: "GET", path: "/specs/:project/:name/:file" },
  // Events
  { method: "GET", path: "/events" },
  { method: "GET", path: "/events/stream" },
  // Version (self)
  { method: "GET", path: "/version" },
];

/**
 * Module-level singleton: build the version route ONCE.
 * The handler closes over the capability list — no per-request work.
 *
 * `buildVersionRoutes` only reads method/path off each Route to compute
 * capability strings — the synthetic 500 handler is never invoked.
 */
const versionRoute = buildVersionRoutes(
  LEGACY_DISPATCH_ROUTES.map((r) => ({
    ...r,
    handler: () => new Response(null, { status: 500 }),
  })),
)[0]!;

/** Create the route dispatch handler, optionally backed by a database. */
export function createRequestHandler(state: ServerState, db?: Db) {
  return function handleRequest(
    request: Request,
    server: import("bun").Server<WsData>,
  ): Response | Promise<Response> | undefined {
    const url = new URL(request.url);

    // ── WebSocket upgrade routes ──────────────────────────────────────────
    const wsResult = handleWsUpgrade(state, request, url, server);
    // null  → URL didn't match any WS route; continue to HTTP dispatch
    // undefined → upgrade succeeded (Bun convention: return undefined)
    // Response → auth failure, connection limit, bad request, etc.
    if (wsResult !== null) return wsResult;

    // CORS preflight — must be exempted from auth so browsers can negotiate headers
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    // ── Origin defense-in-depth ───────────────────────────────────────────
    // Browser requests from non-Tailscale origins are rejected with 403 before
    // any real work happens. Non-browser clients (curl, wscat) omit Origin and
    // are unaffected. Malformed Origin values are treated as absent (we can't
    // confidently classify a garbage string as "non-Tailscale") and fall
    // through to dispatch.
    //
    // Note: the legacy `x-nexus-secret` header gate was removed by
    // `drop-attach-secret-gate`. Reach is now constrained at the bind layer
    // (loopback + Tailscale only) — every connection that reaches dispatch is
    // already authenticated by WireGuard or local OS identity.
    const origin = request.headers.get("origin");
    if (isDisallowedBrowserOrigin(origin)) {
      return new Response(JSON.stringify({ error: "origin not allowed" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Version (no DB required) ─────────────────────────────────────────
    // Wired directly into the dispatcher because the typed route table in
    // routes.ts is NOT dispatched — see LEGACY_DISPATCH_ROUTES above.
    if (url.pathname === "/version" && request.method === "GET") {
      return Promise.resolve(versionRoute.handler(request, {})).then((r) =>
        withCors(request, r),
      );
    }

    if (url.pathname === "/health") {
      return handleHealthGet(request, url, state, db);
    }

    // ── Credential ID pre-validation (before DB guard) ──────────────────
    // Validate credential IDs in path-parameterised routes immediately after
    // auth so that malformed IDs (path traversal, HTML injection, spaces)
    // are rejected with 400 before any DB interaction.  This must run even
    // when no DB is configured so that the sanitisation gate is always active.
    const earlyCredReleaseMatch = url.pathname.match(/^\/credentials\/([^/]+)\/release$/);
    if (earlyCredReleaseMatch && request.method === "POST") {
      if (!CREDENTIAL_ID_RE.test(earlyCredReleaseMatch[1]!)) {
        return withCors(request, new Response("Bad Request", { status: 400 }));
      }
    }
    const earlyCredRateLimitMatch = url.pathname.match(/^\/credentials\/([^/]+)\/report-rate-limit$/);
    if (earlyCredRateLimitMatch && request.method === "POST") {
      if (!CREDENTIAL_ID_RE.test(earlyCredRateLimitMatch[1]!)) {
        return withCors(request, new Response("Bad Request", { status: 400 }));
      }
    }
    const earlyCredHealthMatch = url.pathname.match(/^\/credentials\/([^/]+)\/health$/);
    if (earlyCredHealthMatch && request.method === "GET") {
      if (!CREDENTIAL_ID_RE.test(earlyCredHealthMatch[1]!)) {
        return withCors(request, new Response("Bad Request", { status: 400 }));
      }
    }

    // ── Session & project routes (require DB) ────────────────────────────
    if (db) {
      // GET /sessions
      if (url.pathname === "/sessions" && request.method === "GET") {
        return handleGetSessions(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/sessions", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // POST /sessions/probe — force a reconcile pass NOW (process-watcher)
      if (url.pathname === "/sessions/probe" && request.method === "POST") {
        return handleSessionsProbe(db).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/sessions/probe", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // GET /sessions/{id}
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch && request.method === "GET") {
        return handleGetSessionById(db, sessionMatch[1]!).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/sessions/:id", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // GET /projects
      if (url.pathname === "/projects" && request.method === "GET") {
        return handleGetProjects(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/projects", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/agent/self" && request.method === "GET") {
        return handleGetAgentSelf(db).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/agent/self", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // PATCH /projects/:id — update mutable project metadata (tags, description)
      const projectUpdateMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
      if (projectUpdateMatch && request.method === "PATCH") {
        return handleUpdateProject(db, projectUpdateMatch[1]!, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/projects/:id", method: "PATCH", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // POST /agents — upsert agent config (add or update)
      if (url.pathname === "/agents" && request.method === "POST") {
        return handleSaveAgent(db, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/agents", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // DELETE /agents/:id — remove agent config
      const agentDeleteMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
      if (agentDeleteMatch && request.method === "DELETE") {
        return handleDeleteAgent(db, agentDeleteMatch[1]!).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/agents/:id", method: "DELETE", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/projects/discovered" && request.method === "GET") {
        return handleGetDiscoveredProjects(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/projects/discovered", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // GET /health/history
      if (url.pathname === "/health/history" && request.method === "GET") {
        return handleGetHealthHistory(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/health/history", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // POST /health/ingest — accept a HealthMetrics JSON body from the Rust collector
      if (url.pathname === "/health/ingest" && request.method === "POST") {
        return handleHealthIngest(request, db);
      }

      // ── Notification routes ──────────────────────────────────────────
      if (url.pathname === "/notifications/send" && request.method === "POST") {
        return handleSendNotification(db, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/notifications/send", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // GET /notifications — list canonical NotificationEvent rows for the
      // Swift dashboard. Added by `agent-payload-completeness`. Returns
      // `[]` on empty; never 404 (path matches; the empty-set case has its
      // own contract).
      if (url.pathname === "/notifications" && request.method === "GET") {
        return handleListNotifications(db).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/notifications", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/notifications/settings" && request.method === "GET") {
        return handleGetNotificationSettings(db, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/notifications/settings", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/notifications/settings" && request.method === "PATCH") {
        return handlePatchNotificationSettings(db, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/notifications/settings", method: "PATCH", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/meeting/start" && request.method === "POST") {
        return withCors(request, handleMeetingStart());
      }

      if (url.pathname === "/meeting/end" && request.method === "POST") {
        return handleMeetingEnd().then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/meeting/end", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/meeting/status" && request.method === "GET") {
        return withCors(request, handleMeetingStatus());
      }

      // ── Credential routes (delegated) ────────────────────────────────
      const credResult = tryHandleCredentialRoute(request, url);
      if (credResult !== null) return credResult;

      // ── Analytics routes ──────────────────────────────────────────────
      if (url.pathname === "/analytics/health" && request.method === "GET") {
        return handleAnalyticsHealth(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/analytics/health", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/analytics/specs" && request.method === "GET") {
        return handleAnalyticsSpecs(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/analytics/specs", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/analytics/credentials" && request.method === "GET") {
        return handleAnalyticsCredentials(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/analytics/credentials", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/analytics/git" && request.method === "GET") {
        return handleAnalyticsGit(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/analytics/git", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/analytics/lifecycle" && request.method === "GET") {
        return handleAnalyticsLifecycle(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/analytics/lifecycle", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/analytics/cron" && request.method === "GET") {
        return handleAnalyticsCron(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/analytics/cron", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // ── Statusline & operational routes (require DB for session queries) ──
      if (url.pathname === "/statusline" && request.method === "GET") {
        return handleStatusline(db).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/statusline", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/recommend" && request.method === "GET") {
        return handleRecommend(db).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/recommend", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // ── Events routes (require DB) ────────────────────────────────────
      if (url.pathname === "/events" && request.method === "GET") {
        return handleGetEvents(db, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/events", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // ── Session start (requires DB context) ───────────────────────────
      if (url.pathname === "/session/start" && request.method === "POST") {
        return handleSessionStart(request, db).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/session/start", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // ── Project detail routes (require DB for project resolution) ─────
      const projectStatusMatch = url.pathname.match(/^\/project\/([^/]+)\/status$/);
      if (projectStatusMatch && request.method === "GET") {
        return handleProjectStatus(projectStatusMatch[1]!, url).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/project/:code/status", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      const projectBeadsMatch = url.pathname.match(/^\/project\/([^/]+)\/beads$/);
      if (projectBeadsMatch && request.method === "GET") {
        return handleProjectBeads(projectBeadsMatch[1]!).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/project/:code/beads", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      const projectGitMatch = url.pathname.match(/^\/project\/([^/]+)\/git$/);
      if (projectGitMatch && request.method === "GET") {
        return handleProjectGit(projectGitMatch[1]!).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/project/:code/git", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      const projectSpecsMatch = url.pathname.match(/^\/project\/([^/]+)\/specs$/);
      if (projectSpecsMatch && request.method === "GET") {
        return handleProjectSpecs(projectSpecsMatch[1]!).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/project/:code/specs", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      const projectRunMatch = url.pathname.match(/^\/project\/([^/]+)\/run$/);
      if (projectRunMatch && request.method === "POST") {
        return handleRunCommand(projectRunMatch[1]!, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/project/:code/run", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }
    }

    // ── Routes that do not require a DB connection ────────────────────────

    // ── Spec routes (delegated) ───────────────────────────────────────────
    const specResult = tryHandleSpecRoute(request, url);
    if (specResult !== null) return specResult;

    // ── Command routes (delegated) ────────────────────────────────────────
    const commandResult = tryHandleCommandRoute(request, url);
    if (commandResult !== null) return commandResult;

    // ── Operational routes (no DB required) ──────────────────────────────
    if (url.pathname === "/environment" && request.method === "GET") {
      return handleEnvironment().then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/environment", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    if (url.pathname === "/failures" && request.method === "GET") {
      return handleFailures(url).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/failures", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    if (url.pathname === "/cron" && request.method === "GET") {
      return withCors(request, handleCron());
    }

    // ── SSE stream ──────────────────────────────────────────────────────
    if (url.pathname === "/events/stream" && request.method === "GET") {
      return withCors(request, handleEventsStream());
    }

    return withCors(
      request,
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}
