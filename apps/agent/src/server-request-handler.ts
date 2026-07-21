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
import { getTracer } from "./otel";
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
import { handleHealthProcesses } from "./routes/health-processes";
import { handleHealthProcessWatcher } from "./routes/health-process-watcher";
import {
  handleSendNotification,
  handleListNotifications,
  handleMeetingStart,
  handleMeetingEnd,
  handleMeetingStatus,
} from "./routes/notifications";
import { handleNotificationAudio } from "./routes/notifications-audio";
import { handleApnsRegister } from "./routes/apns-register";
import {
  handleListVoices,
  handlePutVoice,
  handleDeleteVoice,
} from "./routes/notifications-voices";
import {
  handleGetNotificationSettings,
  handlePatchNotificationSettings,
  handleGetRoutingRules,
  handlePutRoutingRules,
} from "./routes/notification-settings";
import { handlePresenceReport } from "./routes/presence-report";
import { handleNotificationDeliver } from "./routes/notifications-deliver";
import { handleGetPresenceFleet } from "./routes/presence-fleet";
import {
  handleAnalyticsHealth,
  handleAnalyticsNotifications,
  handleAnalyticsNotificationsSummary,
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
import { handleEnvironment } from "./routes/environment-route";
import { handleGetSources } from "./routes/sources";
import { handleGetRequests } from "./routes/requests";
import { handleGetQueue } from "./routes/queue";
import { handleGetDecisions } from "./routes/decisions";
import { handlePostDecision } from "./routes/decision";
import { handlePostCapture } from "./routes/capture";
import { handlePostPaste } from "./routes/paste";
import { handleGetTriage } from "./routes/triage";
import { handleGetThread } from "./routes/thread";
import { handleFailures } from "./routes/failures-route";
import { handleCron } from "./routes/cron-routes";
import { handleGetEvents, handleEventsStream } from "./routes/events-sse";
import { handleGetUnlinkedBeads } from "./routes/beads-unlinked";
import { handleGetRoadmap } from "./routes/roadmap";
import { handleGetExceptions } from "./routes/exceptions";
import type { WsData } from "./terminal/stream-manager";
import { ServerState, handleWsUpgrade } from "./server-websocket";
import { isDisallowedBrowserOrigin, withCors } from "./server-origin";
import { CREDENTIAL_ID_RE } from "./server-auth";
import { handleHealthGet, handleHealthIngest } from "./server-health-handler";
import { tryHandleCredentialRoute } from "./server-routes-credentials";
import { tryHandleElevenlabsRoute } from "./server-routes-elevenlabs";
import { tryHandleIntegrationCredentialsRoute } from "./routes/integration-credentials";
import { tryHandleSessionContextRoute } from "./routes/session-context";
import { tryHandleGitEventsRoute } from "./routes/project-status";
import { tryHandlePulseRoute } from "./routes/pulse";
import { tryHandleSpecRoute, tryHandleCommandRoute } from "./server-routes-specs";
import { tryHandleWavePlanRoute } from "./server-routes-wave-plans";
import { buildVersionRoutes, type Route } from "./routes/version-builder";

/**
 * Source-of-truth list of dispatch routes for /version capability reporting.
 *
 * MUST stay in sync with the if/else dispatch chain in `handleRequestInner`
 * below. Adding a new route to the dispatcher? Add it here too — the
 * `server-request-handler-route-parity.test.ts` parity test fails loudly on
 * any drift between this array and the live inline dispatch chain, so the sync
 * is mechanically enforced rather than left to manual audits.
 *
 * Path-parameterised routes use `:id`-style placeholders. Where a route group
 * is delegated to a sub-dispatcher (e.g. /credentials/*, /specs/*), the
 * concrete capability paths are listed here so the /version capabilities array
 * reflects the real API surface. (The former typed `routes.ts` table this
 * comment used to reference was deleted by `apply-4-findings`; the if/else
 * chain in this file is now the sole dispatcher.)
 */
const LEGACY_DISPATCH_ROUTES: Pick<Route, "method" | "path">[] = [
  // Health
  { method: "GET", path: "/health" },
  { method: "POST", path: "/health/ingest" },
  { method: "GET", path: "/health/history" },
  { method: "GET", path: "/health/processes" },
  { method: "GET", path: "/health/process-watcher" },
  // Sessions
  { method: "GET", path: "/sessions" },
  { method: "GET", path: "/sessions/:id" },
  { method: "POST", path: "/session/start" },
  // /sessions-family-consistent alias of POST /session/start (same handler)
  // — redesign-status-usage-endpoints task 2.7. Singular path stays live.
  { method: "POST", path: "/sessions/start" },
  { method: "POST", path: "/sessions/probe" },
  // Session context-window store (add-session-context-api, delegated to
  // routes/session-context.ts). MUST dispatch before the /sessions/:id
  // catch-all so /sessions/:id/context is not swallowed as an :id lookup.
  { method: "GET", path: "/sessions/:id/context" },
  { method: "PATCH", path: "/sessions/:id/context" },
  // Projects
  { method: "GET", path: "/projects" },
  { method: "PATCH", path: "/projects/:id" },
  { method: "GET", path: "/projects/discovered" },
  // Per-project git-event history (add-git-status-orbit, delegated to
  // routes/project-status.ts). Same 4-segment match; `git-events` segment
  // cannot collide with `status` or the PATCH /projects/:id sibling.
  { method: "GET", path: "/projects/:id/git-events" },
  // Per-project pulse (op:/bd:/next: counts for cc-tmux row3, nx-0bhyl.1,
  // delegated to routes/pulse.ts). Same 4-segment match; `pulse` segment
  // cannot collide with `status`/`git-events`/the PATCH /projects/:id sibling.
  { method: "GET", path: "/projects/:code/pulse" },
  // Notifications (the route that triggered this whole spec)
  { method: "POST", path: "/notifications/send" },
  // APNs device-token registration (iOS health-push scheduler, Wave 2).
  { method: "POST", path: "/apns/register" },
  { method: "GET", path: "/notifications" },
  { method: "GET", path: "/notifications/settings" },
  { method: "PATCH", path: "/notifications/settings" },
  // notifications-overhaul: audio cache + per-project voice overrides.
  { method: "GET", path: "/notifications/voices" },
  { method: "PUT", path: "/notifications/voices/:project" },
  { method: "DELETE", path: "/notifications/voices/:project" },
  { method: "GET", path: "/notifications/:id/audio" },
  { method: "POST", path: "/meeting/start" },
  { method: "POST", path: "/meeting/end" },
  { method: "GET", path: "/meeting/status" },
  // context-aware-routing: presence ingest + routing-rule CRUD.
  { method: "POST", path: "/presence/report" },
  { method: "GET", path: "/presence/fleet" },
  { method: "POST", path: "/notifications/deliver" },
  { method: "GET", path: "/notifications/routing-rules" },
  { method: "PUT", path: "/notifications/routing-rules" },
  // Credentials (delegated to server-routes-credentials.ts)
  { method: "GET", path: "/credentials" },
  { method: "POST", path: "/credentials" },
  { method: "GET", path: "/credentials/active" },
  { method: "POST", path: "/credentials/lease" },
  { method: "POST", path: "/credentials/:id/release" },
  { method: "POST", path: "/credentials/:id/report-rate-limit" },
  { method: "GET", path: "/credentials/:id/health" },
  { method: "GET", path: "/credentials/status" },
  // ElevenLabs credential management (delegated to server-routes-elevenlabs.ts)
  { method: "GET", path: "/elevenlabs/credentials" },
  { method: "PATCH", path: "/elevenlabs/credentials" },
  { method: "DELETE", path: "/elevenlabs/credentials" },
  { method: "POST", path: "/elevenlabs/credentials/test" },
  { method: "GET", path: "/elevenlabs/voices" },
  // Generic integration credentials (delegated to routes/integration-credentials.ts)
  { method: "GET", path: "/integrations/:provider/credentials" },
  { method: "PATCH", path: "/integrations/:provider/credentials" },
  { method: "DELETE", path: "/integrations/:provider/credentials" },
  { method: "POST", path: "/integrations/:provider/credentials/test" },
  // Generic voice listing (provider-qualified-project-voices)
  { method: "GET", path: "/integrations/:provider/voices" },
  // Agents (settings)
  { method: "GET", path: "/agent/self" },
  { method: "POST", path: "/agents" },
  { method: "DELETE", path: "/agents/:id" },
  // Analytics
  { method: "GET", path: "/analytics/health" },
  { method: "GET", path: "/analytics/notifications" },
  { method: "GET", path: "/analytics/notifications/summary" },
  { method: "GET", path: "/analytics/specs" },
  { method: "GET", path: "/analytics/credentials" },
  { method: "GET", path: "/analytics/git" },
  { method: "GET", path: "/analytics/lifecycle" },
  { method: "GET", path: "/analytics/cron" },
  // Operational
  { method: "GET", path: "/statusline" },
  { method: "GET", path: "/recommend" },
  { method: "GET", path: "/environment" },
  { method: "GET", path: "/sources" },
  { method: "GET", path: "/requests" },
  // Decide-flow menubar (add-decide-flow-menubar)
  { method: "GET", path: "/queue" },
  { method: "GET", path: "/decisions" },
  { method: "POST", path: "/requests/:id/decision" },
  // Paste-to-project drop (add-paste-to-project)
  { method: "POST", path: "/paste" },
  // Capture passthrough (add-capture-proxy — proxies the mx gateway).
  { method: "POST", path: "/capture" },
  { method: "GET", path: "/triage" },
  { method: "GET", path: "/thread" },
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
  // specs-tab-start-on-spec — sessions linkage + status PATCH.
  { method: "GET", path: "/specs/:project/:name/sessions" },
  { method: "PATCH", path: "/specs/:project/:name/status" },
  // Beads + roadmap (add-bead-proposal-roadmap-surface)
  { method: "GET", path: "/beads/unlinked" },
  { method: "GET", path: "/roadmap" },
  // Fleet exceptions feed (add-fleet-exceptions-feed)
  { method: "GET", path: "/exceptions" },
  // Events
  { method: "GET", path: "/events" },
  { method: "GET", path: "/events/stream" },
  // Wave plans (specs-tab-accordion-with-topology)
  { method: "GET", path: "/wave-plans/active" },
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

/**
 * Per-route caught-error fail modes (mechanize-route-registry-parity, GOD-02).
 * `dispatchRoute` replaces the 57 verbatim `.then(withCors).catch(...)` blocks
 * that used to wrap every route. Each route passes its EXACT pre-refactor
 * (status, body) pair — default 500, fail-loud 502, or a fail-soft 200 with a
 * route-specific empty body — so the refactor changes only WHERE the wrapper
 * lives, never what any route returns on success or failure. Full per-route
 * enumeration: design.md ## Section: Fail-mode inventory.
 */
const FAIL_500 = { status: 500, body: JSON.stringify({ error: "internal error" }) };
const FAIL_502 = { status: 502, body: JSON.stringify({ error: "internal error" }) };

/**
 * Await a route handler's promise, apply CORS to its response, and on a caught
 * rejection log `{ route, method, err }` and return the route's fail-mode
 * response (CORS-wrapped). `handled` is the already-invoked handler promise, so
 * a synchronous throw at the call site propagates exactly as it did with the
 * old inline `.then().catch()` form.
 */
async function dispatchRoute(
  request: Request,
  route: string,
  method: string,
  handled: Promise<Response>,
  fail: { status: number; body: string } = FAIL_500,
): Promise<Response> {
  try {
    return withCors(request, await handled);
  } catch (err) {
    logger.error({ route, method, err }, "route handler failed");
    return withCors(
      request,
      new Response(fail.body, {
        status: fail.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}

/** Create the route dispatch handler, optionally backed by a database. */
export function createRequestHandler(state: ServerState, db?: Db) {
  return function handleRequest(
    request: Request,
    server: import("bun").Server<WsData>,
  ): Response | Promise<Response | undefined> | undefined {
    const url = new URL(request.url);

    // Single chokepoint span for all ~106 routes dispatched below, rather than
    // instrumenting each route handler individually. Mirrors the
    // getTracer().startActiveSpan idiom in socket-server/dispatcher.ts, adapted
    // for a return value instead of fire-and-forget: `handleRequestInner` can
    // resolve sync (Response | undefined) or async (Promise<Response |
    // undefined>), so the status-code attribute + span.end() happen in both
    // branches rather than a single try/finally.
    return getTracer().startActiveSpan(
      "http.request",
      {
        attributes: {
          "http.method": request.method,
          "http.route": url.pathname,
        },
      },
      (span) => {
        const result = handleRequestInner(request, server, url);
        if (result instanceof Promise) {
          return result.then(
            (response) => {
              if (response) span.setAttribute("http.status_code", response.status);
              span.end();
              return response;
            },
            (err: unknown) => {
              span.end();
              throw err;
            },
          );
        }
        if (result) span.setAttribute("http.status_code", result.status);
        span.end();
        return result;
      },
    );
  };

  function handleRequestInner(
    request: Request,
    server: import("bun").Server<WsData>,
    url: URL,
  ): Response | Promise<Response | undefined> | undefined {
    // ── WebSocket upgrade routes ──────────────────────────────────────────
    const wsResult = handleWsUpgrade(state, request, url, server, db);
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

    // ── /health/processes ─────────────────────────────────────────────────
    // Dedicated process-table endpoint (health-tab-process-view). Reads the
    // collector's cached snapshot — no recomputation per request. MUST be
    // registered BEFORE any catch-all so the Swift dashboard can poll at a
    // different cadence than the broader /health rollup.
    if (url.pathname === "/health/processes" && request.method === "GET") {
      return withCors(request, handleHealthProcesses(url, state));
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

    // ── Session context-window store (in-memory; no DB) ──────────────────
    // add-session-context-api. Delegated to routes/session-context.ts. MUST
    // dispatch BEFORE the `if (db)` block's `/^\/sessions\/(.+)$/` catch-all,
    // which would otherwise swallow `/sessions/:id/context` as an :id lookup.
    const sessionContextResult = tryHandleSessionContextRoute(request, url, db);
    if (sessionContextResult !== null) return sessionContextResult;

    // ── Session & project routes (require DB) ────────────────────────────
    if (db) {
      // GET /sessions
      if (url.pathname === "/sessions" && request.method === "GET") {
        return dispatchRoute(request, "/sessions", "GET", handleGetSessions(db, url));
      }

      // POST /sessions/probe — force a reconcile pass NOW (process-watcher)
      if (url.pathname === "/sessions/probe" && request.method === "POST") {
        return dispatchRoute(request, "/sessions/probe", "POST", handleSessionsProbe(db));
      }

      // GET /sessions/{id}
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch && request.method === "GET") {
        return dispatchRoute(request, "/sessions/:id", "GET", handleGetSessionById(db, sessionMatch[1]!));
      }

      // GET /projects
      if (url.pathname === "/projects" && request.method === "GET") {
        return dispatchRoute(request, "/projects", "GET", handleGetProjects(db, url));
      }

      if (url.pathname === "/agent/self" && request.method === "GET") {
        return dispatchRoute(request, "/agent/self", "GET", handleGetAgentSelf(db));
      }

      // GET /projects/:id/git-events[?days=<n>] — persisted git transition
      // history (add-git-status-orbit). 4-segment match; the `git-events`
      // segment cannot collide with the `status` route above or the PATCH
      // /projects/:id match below.
      const gitEventsResult = tryHandleGitEventsRoute(request, url, db);
      if (gitEventsResult !== null) return gitEventsResult;

      // GET /projects/:code/pulse — nx-native op:/bd:/next: counts for
      // cc-tmux row3 (nx-0bhyl.1, companion to installfest's
      // cc-tmux-nx-agent-roadmap-pulse). 4-segment match; the `pulse` segment
      // cannot collide with `status`/`git-events`/the PATCH /projects/:id sibling.
      const pulseResult = tryHandlePulseRoute(request, url);
      if (pulseResult !== null) return pulseResult;

      // PATCH /projects/:id — update mutable project metadata (tags, description)
      const projectUpdateMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
      if (projectUpdateMatch && request.method === "PATCH") {
        return dispatchRoute(request, "/projects/:id", "PATCH", handleUpdateProject(db, projectUpdateMatch[1]!, request));
      }

      // POST /agents — upsert agent config (add or update)
      if (url.pathname === "/agents" && request.method === "POST") {
        return dispatchRoute(request, "/agents", "POST", handleSaveAgent(db, request));
      }

      // DELETE /agents/:id — remove agent config
      const agentDeleteMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
      if (agentDeleteMatch && request.method === "DELETE") {
        return dispatchRoute(request, "/agents/:id", "DELETE", handleDeleteAgent(db, agentDeleteMatch[1]!));
      }

      if (url.pathname === "/projects/discovered" && request.method === "GET") {
        return dispatchRoute(request, "/projects/discovered", "GET", handleGetDiscoveredProjects(db, url));
      }

      // GET /health/process-watcher — observability probe for the process
      // watcher tick loop (process-watcher-health-monitoring). Status 200
      // ALWAYS — the `healthy` boolean is the actionable signal.
      if (url.pathname === "/health/process-watcher" && request.method === "GET") {
        return dispatchRoute(request, "/health/process-watcher", "GET", handleHealthProcessWatcher(db));
      }

      // GET /health/history
      if (url.pathname === "/health/history" && request.method === "GET") {
        return dispatchRoute(request, "/health/history", "GET", handleGetHealthHistory(db, url));
      }

      // POST /health/ingest — accept a HealthMetrics JSON body from the Rust collector
      if (url.pathname === "/health/ingest" && request.method === "POST") {
        return handleHealthIngest(request, db);
      }

      // ── Notification routes ──────────────────────────────────────────
      if (url.pathname === "/notifications/send" && request.method === "POST") {
        return dispatchRoute(request, "/notifications/send", "POST", handleSendNotification(db, request));
      }

      // POST /apns/register — the Nexus iOS app registers its APNs device token
      // so the health-push scheduler can send silent flush pushes (Wave 2).
      if (url.pathname === "/apns/register" && request.method === "POST") {
        return dispatchRoute(request, "/apns/register", "POST", handleApnsRegister(request));
      }

      // GET /notifications — list canonical NotificationEvent rows for the
      // Swift dashboard. Added by `agent-payload-completeness`. Returns
      // `[]` on empty; never 404 (path matches; the empty-set case has its
      // own contract).
      if (url.pathname === "/notifications" && request.method === "GET") {
        return dispatchRoute(request, "/notifications", "GET", handleListNotifications(db));
      }

      if (url.pathname === "/notifications/settings" && request.method === "GET") {
        return dispatchRoute(request, "/notifications/settings", "GET", handleGetNotificationSettings(db, request));
      }

      if (url.pathname === "/notifications/settings" && request.method === "PATCH") {
        return dispatchRoute(request, "/notifications/settings", "PATCH", handlePatchNotificationSettings(db, request));
      }

      // ── context-aware-routing: presence ingest + routing-rule CRUD ─────
      if (url.pathname === "/presence/report" && request.method === "POST") {
        return dispatchRoute(request, "/presence/report", "POST", handlePresenceReport(request, db));
      }

      // GET /presence/fleet — dashboard fleet view (cross-machine-delivery,
      // Phase 1.6): fleet rows + resolved live-console + local machine name.
      if (url.pathname === "/presence/fleet" && request.method === "GET") {
        return dispatchRoute(request, "/presence/fleet", "GET", handleGetPresenceFleet(db));
      }

      // POST /notifications/deliver — receive a forwarded notification from a
      // peer agent (cross-machine-delivery, Phase 1.6). Secret-gated; renders
      // locally; NEVER re-forwards (loop guard inside the handler).
      if (url.pathname === "/notifications/deliver" && request.method === "POST") {
        return dispatchRoute(request, "/notifications/deliver", "POST", handleNotificationDeliver(request));
      }

      if (url.pathname === "/notifications/routing-rules" && request.method === "GET") {
        return dispatchRoute(request, "/notifications/routing-rules", "GET", handleGetRoutingRules(db));
      }

      if (url.pathname === "/notifications/routing-rules" && request.method === "PUT") {
        return dispatchRoute(request, "/notifications/routing-rules", "PUT", handlePutRoutingRules(db, request));
      }

      // ── notifications-overhaul: voice overrides + audio cache ──────
      // The voices routes MUST register BEFORE any /notifications/:id
      // shape so the literal "/notifications/voices" path does not get
      // misrouted as `id = "voices"`. The audio route uses an explicit
      // `/audio` suffix match so collisions are impossible.
      if (url.pathname === "/notifications/voices" && request.method === "GET") {
        return dispatchRoute(request, "/notifications/voices", "GET", handleListVoices(db));
      }

      const voicePutMatch = url.pathname.match(/^\/notifications\/voices\/([^/]+)$/);
      if (voicePutMatch && request.method === "PUT") {
        return dispatchRoute(request, "/notifications/voices/:project", "PUT", handlePutVoice(db, voicePutMatch[1]!, request));
      }

      if (voicePutMatch && request.method === "DELETE") {
        return dispatchRoute(request, "/notifications/voices/:project", "DELETE", handleDeleteVoice(db, voicePutMatch[1]!));
      }

      const audioMatch = url.pathname.match(/^\/notifications\/([^/]+)\/audio$/);
      if (audioMatch && request.method === "GET") {
        return dispatchRoute(request, "/notifications/:id/audio", "GET", handleNotificationAudio(db, audioMatch[1]!, request));
      }

      if (url.pathname === "/meeting/start" && request.method === "POST") {
        return withCors(request, handleMeetingStart());
      }

      if (url.pathname === "/meeting/end" && request.method === "POST") {
        return dispatchRoute(request, "/meeting/end", "POST", handleMeetingEnd());
      }

      if (url.pathname === "/meeting/status" && request.method === "GET") {
        return withCors(request, handleMeetingStatus());
      }

      // ── Credential routes (delegated) ────────────────────────────────
      const credResult = tryHandleCredentialRoute(request, url);
      if (credResult !== null) return credResult;

      // ── ElevenLabs credential routes (delegated) ─────────────────────
      const elevenlabsResult = tryHandleElevenlabsRoute(request, url, db);
      if (elevenlabsResult !== null) return elevenlabsResult;

      // ── Generic integration credential routes (delegated) ────────────
      const integrationResult = tryHandleIntegrationCredentialsRoute(
        request,
        url,
        db,
      );
      if (integrationResult !== null) return integrationResult;

      // ── Analytics routes ──────────────────────────────────────────────
      if (url.pathname === "/analytics/health" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/health", "GET", handleAnalyticsHealth(db, url));
      }

      if (url.pathname === "/analytics/notifications" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/notifications", "GET", handleAnalyticsNotifications(db, url));
      }

      if (url.pathname === "/analytics/notifications/summary" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/notifications/summary", "GET", handleAnalyticsNotificationsSummary(db, url));
      }

      if (url.pathname === "/analytics/specs" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/specs", "GET", handleAnalyticsSpecs(db, url));
      }

      if (url.pathname === "/analytics/credentials" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/credentials", "GET", handleAnalyticsCredentials(db, url));
      }

      if (url.pathname === "/analytics/git" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/git", "GET", handleAnalyticsGit(db, url));
      }

      if (url.pathname === "/analytics/lifecycle" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/lifecycle", "GET", handleAnalyticsLifecycle(db, url));
      }

      if (url.pathname === "/analytics/cron" && request.method === "GET") {
        return dispatchRoute(request, "/analytics/cron", "GET", handleAnalyticsCron(db, url));
      }

      // ── Statusline & operational routes (require DB for session queries) ──
      if (url.pathname === "/statusline" && request.method === "GET") {
        return dispatchRoute(request, "/statusline", "GET", handleStatusline(db, url));
      }

      // ── Events routes (require DB) ────────────────────────────────────
      if (url.pathname === "/events" && request.method === "GET") {
        return dispatchRoute(request, "/events", "GET", handleGetEvents(db, url));
      }

      // ── Session start (requires DB context) ───────────────────────────
      // `/session/start` (singular, original) and `/sessions/start` (plural,
      // /sessions-route-family alias — redesign-status-usage-endpoints task
      // 2.7) both route to the SAME handleSessionStart handler. Neither path
      // is removed; the alias exists purely so the /sessions family is
      // discoverable under one naming convention. The plural `/sessions/start`
      // cannot collide with the `/sessions/:id` GET catch-all (GET-only) or
      // the `/sessions/probe` exact match above.
      if (
        (url.pathname === "/session/start" ||
          url.pathname === "/sessions/start") &&
        request.method === "POST"
      ) {
        return dispatchRoute(request, url.pathname, "POST", handleSessionStart(request, db));
      }

      // ── Project detail routes (require DB for project resolution) ─────
      const projectStatusMatch = url.pathname.match(/^\/project\/([^/]+)\/status$/);
      if (projectStatusMatch && request.method === "GET") {
        return dispatchRoute(request, "/project/:code/status", "GET", handleProjectStatus(projectStatusMatch[1]!, url));
      }

      const projectBeadsMatch = url.pathname.match(/^\/project\/([^/]+)\/beads$/);
      if (projectBeadsMatch && request.method === "GET") {
        return dispatchRoute(request, "/project/:code/beads", "GET", handleProjectBeads(projectBeadsMatch[1]!));
      }

      const projectGitMatch = url.pathname.match(/^\/project\/([^/]+)\/git$/);
      if (projectGitMatch && request.method === "GET") {
        return dispatchRoute(request, "/project/:code/git", "GET", handleProjectGit(projectGitMatch[1]!));
      }

      const projectSpecsMatch = url.pathname.match(/^\/project\/([^/]+)\/specs$/);
      if (projectSpecsMatch && request.method === "GET") {
        return dispatchRoute(request, "/project/:code/specs", "GET", handleProjectSpecs(projectSpecsMatch[1]!));
      }

      const projectRunMatch = url.pathname.match(/^\/project\/([^/]+)\/run$/);
      if (projectRunMatch && request.method === "POST") {
        return dispatchRoute(request, "/project/:code/run", "POST", handleRunCommand(projectRunMatch[1]!, request));
      }
    }

    // ── Routes that do not require a DB connection ────────────────────────

    // ── Spec routes (delegated) ───────────────────────────────────────────
    // db is forwarded so the specs-tab-start-on-spec additions
    // (`GET /specs/.../sessions`, `PATCH /specs/.../status`) can join
    // against the live registry; legacy read-only routes ignore it.
    const specResult = tryHandleSpecRoute(request, url, db);
    if (specResult !== null) return specResult;

    // ── Command routes (delegated) ────────────────────────────────────────
    const commandResult = tryHandleCommandRoute(request, url);
    if (commandResult !== null) return commandResult;

    // ── Wave-plan routes (delegated) ──────────────────────────────────────
    // Surfaces the in-flight /apply or /apply:all wave plan to the dashboard
    // (specs-tab-accordion-with-topology). Reads docs/apply/active.txt + the
    // referenced wave-plan.json from disk; no DB required.
    const wavePlanResult = tryHandleWavePlanRoute(request, url);
    if (wavePlanResult !== null) return wavePlanResult;

    // ── Beads + roadmap routes (no DB; read live from bd) ─────────────────
    // add-bead-proposal-roadmap-surface. Both fail-soft inside their
    // handlers (empty payload, never 500) — the catch here is defense in
    // depth for an unexpected throw.
    if (url.pathname === "/beads/unlinked" && request.method === "GET") {
      return dispatchRoute(request, "/beads/unlinked", "GET", handleGetUnlinkedBeads(url, db), { status: 200, body: JSON.stringify({ unlinked: [] }) });
    }

    if (url.pathname === "/roadmap" && request.method === "GET") {
      return dispatchRoute(request, "/roadmap", "GET", handleGetRoadmap(url, db), { status: 200, body: JSON.stringify({ capabilities: [] }) });
    }

    // ── Fleet exceptions feed (add-fleet-exceptions-feed) ─────────────────
    // SWR-cached, fail-soft: the handler returns an empty array (never 500)
    // on any internal error; the catch here is defense in depth.
    if (url.pathname === "/exceptions" && request.method === "GET") {
      return dispatchRoute(request, "/exceptions", "GET", handleGetExceptions(), { status: 200, body: "[]" });
    }

    // ── Operational routes (no DB required) ──────────────────────────────
    if (url.pathname === "/environment" && request.method === "GET") {
      return dispatchRoute(request, "/environment", "GET", handleEnvironment());
    }

    // ── Source Index passthrough (no DB; proxies the mx gateway :8799) ────
    if (url.pathname === "/sources" && request.method === "GET") {
      // Fail-soft even on an unexpected throw: empty index, not 500.
      return dispatchRoute(request, "/sources", "GET", handleGetSources(), { status: 200, body: JSON.stringify({ sources: [], inbox: [] }) });
    }

    // ── Request-history passthrough (no DB; proxies the mx gateway :8799) ─
    if (url.pathname === "/requests" && request.method === "GET") {
      // Fail-soft even on an unexpected throw: empty history, not 500.
      return dispatchRoute(request, "/requests", "GET", handleGetRequests(request), { status: 200, body: JSON.stringify({ requests: [] }) });
    }

    // ── Decision-queue passthrough (no DB; proxies the mx gateway :8799) ──
    // Decide-flow menubar (add-decide-flow-menubar). Fail-soft inside the
    // handler (empty { items: [] }, never 500) — the catch here is defense in
    // depth for an unexpected throw.
    if (url.pathname === "/queue" && request.method === "GET") {
      // Fail-soft even on an unexpected throw: empty queue, not 500.
      return dispatchRoute(request, "/queue", "GET", handleGetQueue(request), { status: 200, body: JSON.stringify({ items: [] }) });
    }

    // ── Decision-feed passthrough (no DB; proxies the mx gateway :8799) ───
    // Fail-soft inside the handler (empty `[]`, never 500) — the catch here is
    // defense in depth for an unexpected throw. mx /decisions is a bare ARRAY.
    if (url.pathname === "/decisions" && request.method === "GET") {
      // Fail-soft even on an unexpected throw: empty array, not 500.
      return dispatchRoute(request, "/decisions", "GET", handleGetDecisions(request), { status: 200, body: JSON.stringify([]) });
    }

    // ── Decision passthrough (no DB; proxies the mx gateway :8799) ────────
    // POST /requests/{id}/decision (add-decide-flow-menubar). NOT fail-soft:
    // the handler relays the gateway status/body verbatim and maps a network
    // failure to 504. Distinct method (POST) from GET /requests, so no
    // collision with the request-history route above.
    const decisionMatch = url.pathname.match(/^\/requests\/([^/]+)\/decision$/);
    if (decisionMatch && request.method === "POST") {
      // A dropped decision must surface loudly — 502, never an empty 200.
      return dispatchRoute(request, "/requests/:id/decision", "POST", handlePostDecision(request), FAIL_502);
    }

    // ── Capture passthrough (no DB; proxies the mx gateway :8799) ─────────
    // POST /capture (add-capture-proxy). NOT fail-soft: the handler relays the
    // gateway status/body verbatim and maps a network failure to 504 — a
    // dropped capture must surface loudly so the Shortcut re-taps. Dispatched
    // after the origin defense-in-depth block, so a disallowed browser origin
    // is already rejected with 403 before reaching here.
    if (url.pathname === "/capture" && request.method === "POST") {
      // A dropped capture must surface loudly — 502, never a fabricated 200.
      return dispatchRoute(request, "/capture", "POST", handlePostCapture(request), FAIL_502);
    }

    // ── Paste-to-project drop (add-paste-to-project) ──────────────────────
    // POST /paste writes decoded file bytes into a resolved project dir
    // (`<cwd>/docs/screenshots`) or an absolute path. Distinct from POST
    // /capture (mx-gateway proxy) — paste lands on disk, never forwards. NOT
    // fail-soft: unresolved project -> 404, bad/oversized/undecodable body ->
    // 400, filesystem error -> 500, never a fabricated success. `db` is
    // forwarded for project-id resolution; project-code resolution via the
    // config-loader works without it.
    if (url.pathname === "/paste" && request.method === "POST") {
      // A dropped paste must surface loudly — 502, never a fabricated 200.
      return dispatchRoute(request, "/paste", "POST", handlePostPaste(request, db), FAIL_502);
    }

    // ── Triage feed passthrough (no DB; proxies the mx gateway :8799) ─────
    if (url.pathname === "/triage" && request.method === "GET") {
      // Fail-soft even on an unexpected throw: empty feed, not 500.
      return dispatchRoute(request, "/triage", "GET", handleGetTriage(url), { status: 200, body: "[]" });
    }

    // ── Thread passthrough (no DB; proxies the mx gateway :8799) ──────────
    // On-demand conversation history for a single comms item (mx-rkir.1).
    if (url.pathname === "/thread" && request.method === "GET") {
      // Fail-soft even on an unexpected throw: empty thread, not 500.
      return dispatchRoute(request, "/thread", "GET", handleGetThread(url), { status: 200, body: '{"messages":[]}' });
    }

    if (url.pathname === "/failures" && request.method === "GET") {
      return dispatchRoute(request, "/failures", "GET", handleFailures(url));
    }

    if (url.pathname === "/cron" && request.method === "GET") {
      return dispatchRoute(request, "/cron", "GET", handleCron(db));
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
  }
}
