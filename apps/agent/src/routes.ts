/**
 * Declarative route table for the nexus-agent HTTP API.
 *
 * Each route is a plain object declaring method, path, handler, and flags.
 * The handler signature `(req, params) => Response | Promise<Response>` is
 * uniform; closures capture `db`, `state`, and other dependencies.
 *
 * This replaces the ~400-line if/else chain that was in server.ts.
 */

import type { Db } from "@nexus/db";
import type { HealthMetrics } from "@nexus/core";
import { logger } from "@nexus/core";
import os from "node:os";
import type { Route } from "./router";
import type { ServerState } from "./server-websocket";
import { handleGetSessions, handleGetSessionById, handleSessionStart } from "./routes/sessions";
import { handleGetProjects } from "./routes/projects";
import { handleGetAgentSelf } from "./routes/agent-self";
import { handleGetDiscoveredProjects } from "./routes/projects-discovered";
import { handleGetHealthHistory } from "./routes/health-history";
import { insertHealthSnapshot } from "./db/health";
import {
  handleSendNotification,
  handleMeetingStart,
  handleMeetingEnd,
  handleMeetingStatus,
} from "./routes/notifications";
import {
  handleAddCredential,
  handleLeaseCredential,
  handleReleaseCredential,
  handleListCredentials,
  handleReportRateLimit,
  handleCredentialHealth,
} from "./routes/credentials";
import {
  handleGetSpecsAll,
  handleListSpecs,
  handleGetSpec,
  handleApproveSpec,
  handleRejectSpec,
  handleReadSpec,
  handleSpecStatus,
} from "./routes/specs";
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
import {
  handleListCommands,
  handleListCommandsByNamespace,
  handleUpdateCommand,
} from "./routes/commands";
import { handleStatusline } from "./routes/statusline";
import { handleHooks } from "./routes/hooks";
import { handleRecommend } from "./routes/recommend";
import { handleEnvironment } from "./routes/environment-route";
import { handleFailures } from "./routes/failures-route";
import { handleCron } from "./routes/cron-routes";
import { handleGetEvents, handleEventsStream } from "./routes/events-sse";

// ── Credential ID validation ────────────────────────────────────────────────
const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate a credential ID path parameter. Returns a 400 Response or null. */
function validateCredentialId(id: string): Response | null {
  if (!CREDENTIAL_ID_RE.test(id)) {
    return new Response("Bad Request", { status: 400 });
  }
  return null;
}

/** Stubbed health payload used while the collector is warming up. */
function stubbedHealthPayload(): HealthMetrics {
  return {
    hostname: os.hostname(),
    uptime_seconds: Math.floor(os.uptime()),
    cpu: { overall_percent: 0, per_core_percent: [], load_average: os.loadavg() },
    ram: { total_bytes: 0, used_bytes: 0, percent: 0 },
    disk: [],
    docker: null,
  };
}

// ---------------------------------------------------------------------------
// Route table factory
// ---------------------------------------------------------------------------

/**
 * Build the full route table.
 *
 * Routes that need the database are flagged with `requiresDb: true` so the
 * router skips them when no DB is configured. The `db` parameter is captured
 * in closures — it may be undefined at runtime, but the router's DB guard
 * ensures those closures are never invoked without a valid connection.
 */
export function buildRoutes(state: ServerState, db?: Db): Route[] {
  // Cast to non-optional inside DB-guarded closures. The router guarantees
  // these handlers are only called when `hasDb` is true (i.e. db is defined).
  const dbRef = db as Db;

  return [
    // ── Health ─────────────────────────────────────────────────────────────
    {
      method: "GET",
      path: "/health",
      requiresAuth: true,
      handler(req) {
        const url = new URL(req.url);
        const detail = url.searchParams.get("detail") === "true";
        const latest = state.healthCollector.getLatest();

        let payload: HealthMetrics;
        let warmingUp = false;

        if (latest) {
          payload = { ...latest };
        } else {
          payload = stubbedHealthPayload();
          warmingUp = true;
        }

        if (!detail) {
          delete payload.network;
          delete payload.processes;
        }

        const body = JSON.stringify(
          warmingUp ? { ...payload, _note: "warming up — metrics not yet collected" } : payload,
        );

        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },

    // ── Health ingest (requires DB) ────────────────────────────────────────
    {
      method: "POST",
      path: "/health/ingest",
      requiresDb: true,
      async handler(req) {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as Record<string, unknown>).hostname !== "string" ||
          typeof (body as Record<string, unknown>).uptime_seconds !== "number" ||
          typeof (body as Record<string, unknown>).cpu !== "object" ||
          typeof (body as Record<string, unknown>).ram !== "object" ||
          !Array.isArray((body as Record<string, unknown>).disk)
        ) {
          return new Response(JSON.stringify({ error: "invalid body: missing required fields" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const metrics = body as HealthMetrics;

        let diskPercent: number | null = null;
        if (metrics.disk.length > 0) {
          const totalBytes = metrics.disk.reduce((s, d) => s + d.total_bytes, 0);
          if (totalBytes > 0) {
            diskPercent = metrics.disk.reduce(
              (s, d) => s + (d.percent * d.total_bytes) / totalBytes,
              0,
            );
            diskPercent = Math.round(diskPercent * 10) / 10;
          } else {
            diskPercent = metrics.disk[0]?.percent ?? null;
          }
        }

        const snapshot = {
          timestamp: new Date(),
          cpuPercent: (metrics.cpu as { overall_percent: number }).overall_percent,
          ramPercent: (metrics.ram as { percent: number }).percent,
          diskPercent,
          dockerContainers: metrics.docker?.containers ?? null,
          rawJson: JSON.stringify(metrics),
        };

        try {
          await insertHealthSnapshot(dbRef, snapshot);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          logger.error({ err }, "health ingest: failed to insert snapshot");
          return new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },

    // ── Sessions (require DB) ──────────────────────────────────────────────
    {
      method: "GET",
      path: "/sessions",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleGetSessions(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/sessions/:id",
      requiresDb: true,
      handler(_req, params) {
        return handleGetSessionById(dbRef, params.id!);
      },
    },
    {
      method: "POST",
      path: "/session/start",
      requiresDb: true,
      handler(req) {
        return handleSessionStart(req);
      },
    },

    // ── Projects (require DB) ──────────────────────────────────────────────
    {
      method: "GET",
      path: "/projects",
      requiresDb: true,
      handler() {
        return handleGetProjects(dbRef);
      },
    },
    {
      method: "GET",
      path: "/agent/self",
      requiresDb: true,
      handler() {
        return handleGetAgentSelf(dbRef);
      },
    },
    {
      method: "GET",
      path: "/projects/discovered",
      requiresDb: true,
      handler() {
        return handleGetDiscoveredProjects(dbRef);
      },
    },

    // ── Health history (requires DB) ───────────────────────────────────────
    {
      method: "GET",
      path: "/health/history",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleGetHealthHistory(dbRef, url);
      },
    },

    // ── Notifications (require DB) ─────────────────────────────────────────
    {
      method: "POST",
      path: "/notifications/send",
      requiresDb: true,
      handler(req) {
        return handleSendNotification(dbRef, req);
      },
    },
    {
      method: "POST",
      path: "/meeting/start",
      requiresDb: true,
      handler() {
        return handleMeetingStart();
      },
    },
    {
      method: "POST",
      path: "/meeting/end",
      requiresDb: true,
      handler() {
        return handleMeetingEnd();
      },
    },
    {
      method: "GET",
      path: "/meeting/status",
      requiresDb: true,
      handler() {
        return handleMeetingStatus();
      },
    },

    // ── Credentials (require DB) ───────────────────────────────────────────
    {
      method: "POST",
      path: "/credentials",
      requiresDb: true,
      handler(req) {
        return handleAddCredential(req);
      },
    },
    {
      method: "GET",
      path: "/credentials",
      requiresDb: true,
      handler() {
        return handleListCredentials();
      },
    },
    {
      method: "POST",
      path: "/credentials/lease",
      requiresDb: true,
      handler(req) {
        return handleLeaseCredential(req);
      },
    },
    // Credential parameterized routes are NOT gated by requiresDb so that
    // credential ID validation (returning 400 for malformed IDs) runs even
    // when no DB is configured.  The handlers themselves check for pool
    // initialization and return 500 if not ready.
    {
      method: "POST",
      path: "/credentials/:id/release",
      handler(_req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleReleaseCredential(params.id!);
      },
    },
    {
      method: "POST",
      path: "/credentials/:id/report-rate-limit",
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleReportRateLimit(params.id!, req);
      },
    },
    {
      method: "GET",
      path: "/credentials/:id/health",
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleCredentialHealth(params.id!, req);
      },
    },
    {
      method: "GET",
      path: "/credentials/status",
      requiresDb: true,
      handler() {
        return handleListCredentials();
      },
    },

    // ── Analytics (require DB) ─────────────────────────────────────────────
    {
      method: "GET",
      path: "/analytics/health",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsHealth(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/specs",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsSpecs(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/credentials",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsCredentials(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/git",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsGit(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/lifecycle",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsLifecycle(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/cron",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsCron(dbRef, url);
      },
    },

    // ── Statusline & operational routes (require DB) ───────────────────────
    {
      method: "GET",
      path: "/statusline",
      requiresDb: true,
      handler() {
        return handleStatusline(dbRef);
      },
    },
    {
      method: "POST",
      path: "/hooks",
      requiresDb: true,
      handler(req) {
        return handleHooks(dbRef, req);
      },
    },
    {
      method: "GET",
      path: "/recommend",
      requiresDb: true,
      handler() {
        return handleRecommend(dbRef);
      },
    },

    // ── Events (require DB) ────────────────────────────────────────────────
    {
      method: "GET",
      path: "/events",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleGetEvents(dbRef, url);
      },
    },

    // ── Project detail routes (require DB) ─────────────────────────────────
    {
      method: "GET",
      path: "/project/:code/status",
      requiresDb: true,
      handler(req, params) {
        const url = new URL(req.url);
        return handleProjectStatus(params.code!, url);
      },
    },
    {
      method: "GET",
      path: "/project/:code/beads",
      requiresDb: true,
      handler(_req, params) {
        return handleProjectBeads(params.code!);
      },
    },
    {
      method: "GET",
      path: "/project/:code/git",
      requiresDb: true,
      handler(_req, params) {
        return handleProjectGit(params.code!);
      },
    },
    {
      method: "GET",
      path: "/project/:code/specs",
      requiresDb: true,
      handler(_req, params) {
        return handleProjectSpecs(params.code!);
      },
    },
    {
      method: "POST",
      path: "/project/:code/run",
      requiresDb: true,
      handler(req, params) {
        return handleRunCommand(params.code!, req);
      },
    },

    // ── Spec routes (no DB required) ───────────────────────────────────────
    {
      method: "GET",
      path: "/specs/all",
      handler() {
        return handleGetSpecsAll();
      },
    },
    {
      method: "GET",
      path: "/specs",
      handler(req) {
        const url = new URL(req.url);
        return handleListSpecs(url);
      },
    },
    {
      method: "POST",
      path: "/specs/:project/:name/approve",
      handler(_req, params) {
        return handleApproveSpec(params.project!, params.name!);
      },
    },
    {
      method: "POST",
      path: "/specs/:project/:name/reject",
      handler(req, params) {
        return handleRejectSpec(params.project!, params.name!, req);
      },
    },
    {
      method: "POST",
      path: "/specs/:project/:name/read",
      handler(_req, params) {
        return handleReadSpec(params.project!, params.name!);
      },
    },
    {
      method: "GET",
      path: "/specs/:project/:name/status",
      handler(_req, params) {
        return handleSpecStatus(params.project!, params.name!);
      },
    },
    // This must come AFTER the more specific /specs/:project/:name/* routes
    // so that /approve, /reject, /read, /status are matched first.
    {
      method: "GET",
      path: "/specs/:project/:name",
      handler(_req, params) {
        return handleGetSpec(params.project!, params.name!);
      },
    },

    // ── Command routes (no DB required) ────────────────────────────────────
    {
      method: "GET",
      path: "/commands",
      handler(req) {
        const url = new URL(req.url);
        return handleListCommands(url);
      },
    },
    {
      method: "GET",
      path: "/commands/:name",
      handler(_req, params) {
        // Router already decodes path params via decodeURIComponent
        return handleListCommandsByNamespace(params.name!);
      },
    },
    {
      method: "PUT",
      path: "/commands/:name",
      handler(req, params) {
        // Router already decodes path params via decodeURIComponent
        return handleUpdateCommand(params.name!, req);
      },
    },

    // ── Operational routes (no DB required) ────────────────────────────────
    {
      method: "GET",
      path: "/environment",
      handler() {
        return handleEnvironment();
      },
    },
    {
      method: "GET",
      path: "/failures",
      handler(req) {
        const url = new URL(req.url);
        return handleFailures(url);
      },
    },
    {
      method: "GET",
      path: "/cron",
      handler() {
        return handleCron();
      },
    },

    // ── SSE stream (no DB required) ────────────────────────────────────────
    {
      method: "GET",
      path: "/events/stream",
      handler() {
        return handleEventsStream();
      },
    },
  ];
}
