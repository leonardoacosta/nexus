import type { Db } from "@nexus/db";
import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core";
import type { HealthMetrics } from "@nexus/core";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import { handleGetSessions, handleGetSessionById } from "./routes/sessions";
import { handleGetProjects } from "./routes/projects";
import { handleGetAgentSelf } from "./routes/agent-self";
import { handleGetDiscoveredProjects } from "./routes/projects-discovered";
import { handleGetHealthHistory } from "./routes/health-history";
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
import { HealthCollector } from "./health-collector";
import { StreamManager, type WsData } from "./terminal/stream-manager";

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
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ── Credential ID validation ────────────────────────────────────────────────
const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;

const healthCollector = new HealthCollector();
healthCollector.start();

const streamManager = new StreamManager();

// ── WebSocket keepalive ──────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const pongDeadlines = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>();

let pingTimer: ReturnType<typeof setInterval> | null = null;
const allSockets = new Set<ServerWebSocket<WsData>>();

function startPingTimer(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const ws of allSockets) {
      ws.ping();
      // Set a deadline for pong response
      const timeout = setTimeout(() => {
        pongDeadlines.delete(ws);
        // Clean up viewer state before closing (task 1.6)
        streamManager.removeViewer(ws);
        if (streamManager.viewerCount(ws.data.sessionId) === 0) {
          streamManager.endSession(ws.data.sessionId);
        }
        try {
          ws.close(1001, "pong timeout");
        } catch {
          // already closed
        }
      }, PONG_TIMEOUT_MS);
      pongDeadlines.set(ws, timeout);
    }
  }, PING_INTERVAL_MS);
}

function stopPingTimer(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  for (const t of pongDeadlines.values()) clearTimeout(t);
  pongDeadlines.clear();
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
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

// ── WebSocket route patterns ────────────────────────────────────────────────

const WS_STREAM_RE = /^\/sessions\/([^/]+)\/stream$/;
const WS_INTERACT_RE = /^\/sessions\/([^/]+)\/interact$/;

/** Create the route dispatch handler, optionally backed by a database. */
function createRequestHandler(db?: Db) {
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
      // Validate secret header using constant-time comparison (Task 2.2/2.3)
      const streamAuthErr = requireSecret(request);
      if (streamAuthErr) return streamAuthErr;
      // Task 1.3: Enforce connection limit
      if (allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!streamManager.getPty(sessionId)) {
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
      // Validate secret header using constant-time comparison (Task 2.2/2.3)
      const interactAuthErr = requireSecret(request);
      if (interactAuthErr) return interactAuthErr;
      // Task 1.3: Enforce connection limit
      if (allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!streamManager.getPty(sessionId)) {
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
      const latest = healthCollector.getLatest();

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

    // ── Session & project routes (require DB) ────────────────────────────
    if (db) {
      // GET /sessions
      if (url.pathname === "/sessions" && request.method === "GET") {
        return handleGetSessions(db, url).then((r) => withCors(request, r));
      }

      // GET /sessions/{id}
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch && request.method === "GET") {
        return handleGetSessionById(db, sessionMatch[1]!).then((r) => withCors(request, r));
      }

      // GET /projects
      if (url.pathname === "/projects" && request.method === "GET") {
        return handleGetProjects(db).then((r) => withCors(request, r));
      }

      if (url.pathname === "/agent/self" && request.method === "GET") {
        return handleGetAgentSelf(db).then((r) => withCors(request, r));
      }

      if (url.pathname === "/projects/discovered" && request.method === "GET") {
        return handleGetDiscoveredProjects(db).then((r) => withCors(request, r));
      }

      // GET /health/history
      if (url.pathname === "/health/history" && request.method === "GET") {
        return handleGetHealthHistory(db, url).then((r) => withCors(request, r));
      }

      // ── Notification routes ──────────────────────────────────────────
      if (url.pathname === "/notifications/send" && request.method === "POST") {
        return handleSendNotification(db, request).then((r) => withCors(request, r));
      }

      if (url.pathname === "/meeting/start" && request.method === "POST") {
        return withCors(request, handleMeetingStart());
      }

      if (url.pathname === "/meeting/end" && request.method === "POST") {
        return handleMeetingEnd().then((r) => withCors(request, r));
      }

      if (url.pathname === "/meeting/status" && request.method === "GET") {
        return withCors(request, handleMeetingStatus());
      }

      // ── Credential routes ────────────────────────────────────────────
      if (url.pathname === "/credentials" && request.method === "POST") {
        return handleAddCredential(request).then((r) => withCors(request, r));
      }

      if (url.pathname === "/credentials" && request.method === "GET") {
        return handleListCredentials().then((r) => withCors(request, r));
      }

      if (url.pathname === "/credentials/lease" && request.method === "POST") {
        return handleLeaseCredential(request).then((r) => withCors(request, r));
      }

      const credReleaseMatch = url.pathname.match(/^\/credentials\/([^/]+)\/release$/);
      if (credReleaseMatch && request.method === "POST") {
        if (!CREDENTIAL_ID_RE.test(credReleaseMatch[1]!)) {
          return withCors(request, new Response("Bad Request", { status: 400 }));
        }
        return handleReleaseCredential(credReleaseMatch[1]!).then((r) => withCors(request, r));
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
        );
      }

      // GET /credentials/{id}/health — per-credential health check
      const credHealthMatch = url.pathname.match(/^\/credentials\/([^/]+)\/health$/);
      if (credHealthMatch && request.method === "GET") {
        if (!CREDENTIAL_ID_RE.test(credHealthMatch[1]!)) {
          return withCors(request, new Response("Bad Request", { status: 400 }));
        }
        return handleCredentialHealth(credHealthMatch[1]!).then((r) => withCors(request, r));
      }

      // GET /credentials/status — pool overview
      if (url.pathname === "/credentials/status" && request.method === "GET") {
        return handleListCredentials().then((r) => withCors(request, r));
      }
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

export { healthCollector, streamManager };

export function startServer(
  port: number = PORT,
  db?: Db,
  options?: { encryptionKey?: import("node:buffer").Buffer; prerotateThreshold?: number },
) {
  // Initialize subsystems that need the DB
  if (db) {
    initNotificationRoutes(db);
    initCredentialRoutes(db, {
      encryptionKey: options?.encryptionKey,
      prerotateThreshold: options?.prerotateThreshold,
    });
  }

  const handler = createRequestHandler(db);

  const server = Bun.serve<WsData>({
    port,
    fetch(req, server) {
      return handler(req, server);
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        allSockets.add(ws);
        startPingTimer();

        if (ws.data.mode === "interact") {
          // Try to claim the writer mutex
          const claimed = streamManager.claimWriter(ws);
          if (!claimed) {
            ws.close(4009, "interactive session already held by another client");
            allSockets.delete(ws);
            return;
          }
        }

        // Register as viewer (both stream and interact get output)
        streamManager.addViewer(ws);

        logger.debug({ sessionId: ws.data.sessionId, mode: ws.data.mode }, "ws: open");
      },

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        const { sessionId, mode } = ws.data;

        if (mode !== "interact") {
          // Stream-only clients cannot send data
          return;
        }

        // Defense-in-depth: ensure this socket holds the writer mutex before
        // processing any input. Protects against race conditions where a socket
        // loses writer status between the open() claim and message receipt.
        if (!streamManager.isWriter(ws)) {
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
              const pty = streamManager.getPty(sessionId);
              if (pty) {
                pty.resize(cols, rows);
              }
              return;
            }
          } catch {
            // Not JSON — treat as text input
          }
          // Write text as bytes
          const pty = streamManager.getPty(sessionId);
          if (pty) {
            pty.write(new TextEncoder().encode(msg));
          }
          return;
        }

        // Binary frame — raw stdin bytes
        const pty = streamManager.getPty(sessionId);
        if (pty) {
          const data = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
          pty.write(data);
        }
      },

      close(ws: ServerWebSocket<WsData>) {
        allSockets.delete(ws);
        const deadline = pongDeadlines.get(ws);
        if (deadline) {
          clearTimeout(deadline);
          pongDeadlines.delete(ws);
        }

        streamManager.removeViewer(ws);

        logger.debug({ sessionId: ws.data.sessionId, mode: ws.data.mode }, "ws: close");

        // Stop ping timer if no sockets remain
        if (allSockets.size === 0) {
          stopPingTimer();
        }
      },

      pong(ws: ServerWebSocket<WsData>) {
        // Clear the pong deadline — connection is still alive
        const deadline = pongDeadlines.get(ws);
        if (deadline) {
          clearTimeout(deadline);
          pongDeadlines.delete(ws);
        }
      },

      // No per-message compression — raw terminal bytes should flow with minimal overhead
      perMessageDeflate: false,
    },
  });

  logger.info({ port: server.port }, "nexus-agent started");
  return server;
}
