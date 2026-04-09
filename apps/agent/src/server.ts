import type { Db } from "@nexus/db";
import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core";
import type { HealthMetrics } from "@nexus/core";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import { handleGetSessions, handleGetSessionById, handleSessionStart } from "./routes/sessions";
import { handleGetProjects } from "./routes/projects";
import { handleGetAgentSelf } from "./routes/agent-self";
import { handleGetDiscoveredProjects } from "./routes/projects-discovered";
import { handleGetHealthHistory } from "./routes/health-history";
import { insertHealthSnapshot } from "./db/health";
import {
  initNotificationRoutes,
  handleSendNotification,
  handleMeetingStart,
  handleMeetingEnd,
  handleMeetingStatus,
} from "./routes/notifications";
import {
  initCredentialRoutes,
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
  initCommandRoutes,
  handleListCommands,
  handleListCommandsByNamespace,
  handleUpdateCommand,
} from "./routes/commands";
import {
  handleStatusline,
  handleHooks,
  handleRecommend,
  handleEnvironment,
  handleFailures,
  handleCron,
} from "./routes/operational";
import { handleGetEvents, handleEventsStream } from "./routes/events-sse";
import { HealthCollector } from "./health-collector";
import { StreamManager, type WsData } from "./terminal/stream-manager";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";

const PORT = 7400;

// ── Security: attach secret ─────────────────────────────────────────────────
const _attachSecretRaw = process.env.NEXUS_ATTACH_SECRET;
if (!_attachSecretRaw) {
  logger.error("NEXUS_ATTACH_SECRET is not set — refusing to start (fail-closed)");
  process.exit(1);
}
const ATTACH_SECRET: string = _attachSecretRaw;

// ── Connection limit ────────────────────────────────────────────────────────
const MAX_CONCURRENT_CONNECTIONS = 50;

// ── Session ID validation ───────────────────────────────────────────────────
const SESSION_ID_RE = /^[a-zA-Z0-9_.-]+$/;

// ── Credential ID validation ────────────────────────────────────────────────
const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ── WebSocket keepalive constants ───────────────────────────────────────────
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ── WebSocket route patterns ────────────────────────────────────────────────
const WS_STREAM_RE = /^\/sessions\/([^/]+)\/stream$/;
const WS_INTERACT_RE = /^\/sessions\/([^/]+)\/interact$/;

// ── Pure utility functions (no state) ──────────────────────────────────────

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

/** Return true if the origin is a Tailscale IP (100.x.x.x). */
function isTailscaleOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return /^100\./.test(url.hostname);
  } catch {
    return false;
  }
}

/** Attach CORS headers when the request comes from a Tailscale origin. */
function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (isTailscaleOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin!);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, x-nexus-secret");
  }
  return response;
}

/**
 * Validate the `x-nexus-secret` header using constant-time comparison.
 *
 * Returns `null` on success (header matches ATTACH_SECRET).
 * Returns a `Response(401)` when the header is missing or does not match.
 * A missing header is normalised to an empty string before comparison so that
 * `Buffer.from(null)` is never called.
 */
function requireSecret(request: Request): Response | null {
  const provided = request.headers.get("x-nexus-secret") ?? "";
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(ATTACH_SECRET);
  // timingSafeEqual requires same-length buffers; treat length mismatch as failure.
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/**
 * Validate WebSocket upgrade authentication.
 *
 * Browsers cannot set custom HTTP headers on WebSocket upgrades, so this
 * function accepts the secret from either:
 *   1. The `x-nexus-secret` request header (used by server-side / non-browser clients), or
 *   2. The `token` query-string parameter (used by browser-based XTerminal).
 *
 * Both paths use constant-time comparison to prevent timing attacks.
 * Returns `null` on success, `Response(401)` on failure.
 */
function requireSecretWs(request: Request, url: URL): Response | null {
  // Prefer the header (same path as requireSecret)
  const fromHeader = request.headers.get("x-nexus-secret");
  const provided = fromHeader !== null ? fromHeader : (url.searchParams.get("token") ?? "");
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(ATTACH_SECRET);
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// ── ServerState: encapsulates all per-server mutable state ─────────────────

/**
 * Encapsulates all mutable state owned by a single server instance.
 *
 * Each call to `ServerState.create()` produces an independent instance so that
 * test files that spin up their own server receive isolated state with no
 * cross-test bleed through shared module-level variables.
 */
export class ServerState {
  readonly healthCollector: HealthCollector;
  readonly streamManager: StreamManager;

  readonly allSockets = new Set<ServerWebSocket<WsData>>();
  readonly pongDeadlines = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();
  pingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(hc: HealthCollector, sm: StreamManager) {
    this.healthCollector = hc;
    this.streamManager = sm;
  }

  /** Create a fresh, isolated ServerState with its own HealthCollector and StreamManager. */
  static create(): ServerState {
    const hc = new HealthCollector();
    hc.start();
    const sm = new StreamManager();
    return new ServerState(hc, sm);
  }

  startPingTimer(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const ws of this.allSockets) {
        ws.ping();
        const timeout = setTimeout(() => {
          this.pongDeadlines.delete(ws);
          // Clean up viewer state before closing (task 1.6)
          this.streamManager.removeViewer(ws);
          if (this.streamManager.viewerCount(ws.data.sessionId) === 0) {
            this.streamManager.endSession(ws.data.sessionId);
          }
          try {
            ws.close(1001, "pong timeout");
          } catch {
            // already closed
          }
        }, PONG_TIMEOUT_MS);
        this.pongDeadlines.set(ws, timeout);
      }
    }, PING_INTERVAL_MS);
  }

  stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const t of this.pongDeadlines.values()) clearTimeout(t);
    this.pongDeadlines.clear();
  }
}

// ── Module-level singleton — used by server.test.ts direct imports ──────────
//
// These are re-exported for backward compat. Code that imports
// `healthCollector` or `streamManager` directly from server.ts gets the
// singleton's instances (the server started by `startServer()`).
//
// Test files that need full isolation should call `ServerState.create()` and
// pass the resulting state to a custom `createRequestHandler` / Bun.serve call.

const _singletonState = ServerState.create();

/**
 * Module-level healthCollector export (singleton).
 * Maintained for backward compat with server.test.ts.
 */
export const healthCollector: HealthCollector = _singletonState.healthCollector;

/**
 * Module-level streamManager export (singleton).
 * Maintained for backward compat with server.test.ts.
 */
export const streamManager: StreamManager = _singletonState.streamManager;

// ── Request handler factory ─────────────────────────────────────────────────

/** Create the route dispatch handler, optionally backed by a database. */
function createRequestHandler(state: ServerState, db?: Db) {
  return function handleRequest(request: Request, server: import("bun").Server<WsData>): Response | Promise<Response> | undefined {
    const url = new URL(request.url);

    // ── WebSocket upgrade routes ──────────────────────────────────────────
    const streamMatch = url.pathname.match(WS_STREAM_RE);
    if (streamMatch) {
      const sessionId = streamMatch[1]!;
      // Task 1.8: Validate session ID against safe pattern
      if (!SESSION_ID_RE.test(sessionId)) {
        return new Response("Bad Request", { status: 400 });
      }
      // Validate secret via header or ?token= query param (browser WS can't set headers)
      const streamAuthErr = requireSecretWs(request, url);
      if (streamAuthErr) return streamAuthErr;
      // Task 1.3: Enforce connection limit
      if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!state.streamManager.getPty(sessionId)) {
        // No PTY attached — session doesn't exist or isn't streamable
        return new Response(JSON.stringify({ error: "session not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const upgraded = server.upgrade(request, {
        data: { sessionId, mode: "stream" },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return undefined;
    }

    const interactMatch = url.pathname.match(WS_INTERACT_RE);
    if (interactMatch) {
      const sessionId = interactMatch[1]!;
      // Task 1.8: Validate session ID against safe pattern
      if (!SESSION_ID_RE.test(sessionId)) {
        return new Response("Bad Request", { status: 400 });
      }
      // Validate secret via header or ?token= query param (browser WS can't set headers)
      const interactAuthErr = requireSecretWs(request, url);
      if (interactAuthErr) return interactAuthErr;
      // Task 1.3: Enforce connection limit
      if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!state.streamManager.getPty(sessionId)) {
        return new Response(JSON.stringify({ error: "session not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const upgraded = server.upgrade(request, {
        data: { sessionId, mode: "interact" },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return undefined;
    }

    // CORS preflight — must be exempted from auth so browsers can negotiate headers
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    // ── Global REST auth middleware ───────────────────────────────────────
    // All REST routes require x-nexus-secret. Applied after WebSocket upgrade
    // checks (which validate inline) and after OPTIONS preflight (browsers must
    // be able to send a preflight without credentials to discover allowed headers).
    const authErr = requireSecret(request);
    if (authErr) return authErr;

    if (url.pathname === "/health") {
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

      // Strip optional detail fields when detail is not requested
      if (!detail) {
        delete payload.network;
        delete payload.processes;
      }

      const body = JSON.stringify(
        warmingUp ? { ...payload, _note: "warming up — metrics not yet collected" } : payload,
      );

      return withCors(
        request,
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
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
        return handleGetProjects(db).then((r) => withCors(request, r)).catch((err) => {
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

      if (url.pathname === "/projects/discovered" && request.method === "GET") {
        return handleGetDiscoveredProjects(db).then((r) => withCors(request, r)).catch((err) => {
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
        return (async () => {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return withCors(request, new Response(JSON.stringify({ error: "invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }));
          }

          // Basic shape validation
          if (
            typeof body !== "object" ||
            body === null ||
            typeof (body as Record<string, unknown>).hostname !== "string" ||
            typeof (body as Record<string, unknown>).uptime_seconds !== "number" ||
            typeof (body as Record<string, unknown>).cpu !== "object" ||
            typeof (body as Record<string, unknown>).ram !== "object" ||
            !Array.isArray((body as Record<string, unknown>).disk)
          ) {
            return withCors(request, new Response(JSON.stringify({ error: "invalid body: missing required fields" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }));
          }

          const metrics = body as import("@nexus/core").HealthMetrics;

          // Weighted-average disk percent (same logic as health-scheduler)
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
            await insertHealthSnapshot(db, snapshot);
            return withCors(request, new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }));
          } catch (err) {
            logger.error({ err }, "health ingest: failed to insert snapshot");
            return withCors(request, new Response(JSON.stringify({ error: "internal error" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }));
          }
        })();
      }

      // ── Notification routes ──────────────────────────────────────────
      if (url.pathname === "/notifications/send" && request.method === "POST") {
        return handleSendNotification(db, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/notifications/send", method: "POST", err }, "route handler failed");
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

      // ── Credential routes ────────────────────────────────────────────
      if (url.pathname === "/credentials" && request.method === "POST") {
        return handleAddCredential(request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/credentials", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/credentials" && request.method === "GET") {
        return handleListCredentials().then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/credentials", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      if (url.pathname === "/credentials/lease" && request.method === "POST") {
        return handleLeaseCredential(request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/credentials/lease", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      const credReleaseMatch = url.pathname.match(/^\/credentials\/([^/]+)\/release$/);
      if (credReleaseMatch && request.method === "POST") {
        if (!CREDENTIAL_ID_RE.test(credReleaseMatch[1]!)) {
          return withCors(request, new Response("Bad Request", { status: 400 }));
        }
        return handleReleaseCredential(credReleaseMatch[1]!).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/credentials/:id/release", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      const credRateLimitMatch = url.pathname.match(
        /^\/credentials\/([^/]+)\/report-rate-limit$/,
      );
      if (credRateLimitMatch && request.method === "POST") {
        if (!CREDENTIAL_ID_RE.test(credRateLimitMatch[1]!)) {
          return withCors(request, new Response("Bad Request", { status: 400 }));
        }
        return handleReportRateLimit(credRateLimitMatch[1]!, request).then((r) =>
          withCors(request, r),
        ).catch((err) => {
          logger.error({ route: "/credentials/:id/report-rate-limit", method: "POST", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // GET /credentials/{id}/health — per-credential health check
      const credHealthMatch = url.pathname.match(/^\/credentials\/([^/]+)\/health$/);
      if (credHealthMatch && request.method === "GET") {
        if (!CREDENTIAL_ID_RE.test(credHealthMatch[1]!)) {
          return withCors(request, new Response("Bad Request", { status: 400 }));
        }
        return handleCredentialHealth(credHealthMatch[1]!, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/credentials/:id/health", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

      // GET /credentials/status — pool overview
      if (url.pathname === "/credentials/status" && request.method === "GET") {
        return handleListCredentials().then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/credentials/status", method: "GET", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }

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

      if (url.pathname === "/hooks" && request.method === "POST") {
        return handleHooks(db, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/hooks", method: "POST", err }, "route handler failed");
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
        return handleSessionStart(request).then((r) => withCors(request, r)).catch((err) => {
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

    // ── Spec routes ───────────────────────────────────────────────────────
    if (url.pathname === "/specs/all" && request.method === "GET") {
      return handleGetSpecsAll().then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs/all", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    if (url.pathname === "/specs" && request.method === "GET") {
      return handleListSpecs(url).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    // GET/POST /specs/:project/:name/* — parameterised spec routes
    const specApproveMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)\/approve$/);
    if (specApproveMatch && request.method === "POST") {
      return handleApproveSpec(specApproveMatch[1]!, specApproveMatch[2]!).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs/:project/:name/approve", method: "POST", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    const specRejectMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)\/reject$/);
    if (specRejectMatch && request.method === "POST") {
      return handleRejectSpec(specRejectMatch[1]!, specRejectMatch[2]!, request).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs/:project/:name/reject", method: "POST", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    const specReadMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)\/read$/);
    if (specReadMatch && request.method === "POST") {
      return handleReadSpec(specReadMatch[1]!, specReadMatch[2]!).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs/:project/:name/read", method: "POST", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    const specStatusMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)\/status$/);
    if (specStatusMatch && request.method === "GET") {
      return handleSpecStatus(specStatusMatch[1]!, specStatusMatch[2]!).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs/:project/:name/status", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    const specDetailMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)$/);
    if (specDetailMatch && request.method === "GET") {
      return handleGetSpec(specDetailMatch[1]!, specDetailMatch[2]!).then((r) => withCors(request, r)).catch((err) => {
        logger.error({ route: "/specs/:project/:name", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
    }

    // ── Command routes ────────────────────────────────────────────────────
    if (url.pathname === "/commands" && request.method === "GET") {
      return withCors(request, handleListCommands(url));
    }

    const commandNameMatch = url.pathname.match(/^\/commands\/([^/]+)$/);
    if (commandNameMatch) {
      const cmdName = decodeURIComponent(commandNameMatch[1]!);
      if (request.method === "GET") {
        return withCors(request, handleListCommandsByNamespace(cmdName));
      }
      if (request.method === "PUT") {
        return handleUpdateCommand(cmdName, request).then((r) => withCors(request, r)).catch((err) => {
          logger.error({ route: "/commands/:name", method: "PUT", err }, "route handler failed");
          return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
        });
      }
    }

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

export function startServer(
  port: number = PORT,
  db?: Db,
  options?: { encryptionKey?: import("node:buffer").Buffer; prerotateThreshold?: number },
) {
  // Use the module singleton state so that module-level `healthCollector` and
  // `streamManager` exports remain valid references to the running server's state.
  const state = _singletonState;

  // Initialize subsystems that need the DB.
  // initNotificationRoutes is async (mutex-guarded) — fire-and-forget here
  // since server startup itself is synchronous and the manager will be ready
  // well before the first real request arrives.
  if (db) {
    safeFireAndForget(initNotificationRoutes(db), "init-notification-routes");
    initCredentialRoutes(db, {
      encryptionKey: options?.encryptionKey,
      prerotateThreshold: options?.prerotateThreshold,
    });
  }

  // Initialize subsystems that do not need the DB.
  initCommandRoutes();

  const handler = createRequestHandler(state, db);

  const server = Bun.serve<WsData>({
    port,
    fetch(req, server) {
      return handler(req, server);
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        state.allSockets.add(ws);
        state.startPingTimer();

        if (ws.data.mode === "interact") {
          // Try to claim the writer mutex
          const claimed = state.streamManager.claimWriter(ws);
          if (!claimed) {
            ws.close(4009, "interactive session already held by another client");
            state.allSockets.delete(ws);
            return;
          }
        }

        // Register as viewer (both stream and interact get output)
        state.streamManager.addViewer(ws);

        logger.debug({ sessionId: ws.data.sessionId, mode: ws.data.mode }, "ws: open");
      },

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        const { sessionId, mode } = ws.data;

        if (mode !== "interact") {
          // Stream-only clients may send a reconnect frame to replay buffered output.
          if (typeof msg === "string") {
            try {
              const parsed = JSON.parse(msg);
              if (parsed.type === "reconnect" && typeof parsed.sessionId === "string") {
                state.streamManager.replayBuffer(ws);
              }
            } catch {
              // Not a valid JSON control frame — ignore
            }
          }
          return;
        }

        // Defense-in-depth: ensure this socket holds the writer mutex before
        // processing any input. Protects against race conditions where a socket
        // loses writer status between the open() claim and message receipt.
        if (!state.streamManager.isWriter(ws)) {
          ws.sendText(JSON.stringify({ type: "error", message: "not the interactive writer" }));
          return;
        }

        // JSON control frames (text)
        if (typeof msg === "string") {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
              // Task 1.7: Validate cols/rows ranges
              const cols = parsed.cols;
              const rows = parsed.rows;
              if (
                !Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1 || cols > 500 ||
                !Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1 || rows > 300
              ) {
                ws.sendText(JSON.stringify({ type: "error", message: "Invalid resize dimensions" }));
                return;
              }
              const pty = state.streamManager.getPty(sessionId);
              if (pty) {
                pty.resize(cols, rows);
              }
              return;
            }
          } catch {
            // Not JSON — treat as text input
          }
          // Write text as bytes
          const pty = state.streamManager.getPty(sessionId);
          if (pty) {
            pty.write(new TextEncoder().encode(msg));
          }
          return;
        }

        // Binary frame — raw stdin bytes
        const pty = state.streamManager.getPty(sessionId);
        if (pty) {
          const data = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
          pty.write(data);
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        state.allSockets.delete(ws);
        const deadline = state.pongDeadlines.get(ws);
        if (deadline) {
          clearTimeout(deadline);
          state.pongDeadlines.delete(ws);
        }

        state.streamManager.removeViewer(ws);
        // Mirror the pong-timeout path: tear down the PTY session when the
        // last viewer disconnects normally (task 1.1 — PTY orphan fix).
        if (state.streamManager.viewerCount(ws.data.sessionId) === 0) {
          state.streamManager.endSession(ws.data.sessionId);
        }

        logger.debug({ sessionId: ws.data.sessionId, mode: ws.data.mode }, "ws: close");

        // Stop ping timer if no sockets remain
        if (state.allSockets.size === 0) {
          state.stopPingTimer();
        }
      },

      pong(ws: ServerWebSocket<WsData>) {
        // Clear the pong deadline — connection is still alive
        const deadline = state.pongDeadlines.get(ws);
        if (deadline) {
          clearTimeout(deadline);
          state.pongDeadlines.delete(ws);
        }
      },

      // No per-message compression — raw terminal bytes should flow with minimal overhead
      perMessageDeflate: false,
    },
  });

  logger.info({ port: server.port }, "nexus-agent started");
  return server;
}
