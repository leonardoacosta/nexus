import type { Db } from "@nexus/db";
import type { ServerWebSocket } from "bun";
import { logger } from "@nexus/core";
import type { HealthMetrics } from "@nexus/core";
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
} from "./routes/credentials";
import { HealthCollector } from "./health-collector";
import { StreamManager, type WsData } from "./terminal/stream-manager";

const PORT = 7400;

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
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return response;
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

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
        return handleReleaseCredential(credReleaseMatch[1]!).then((r) => withCors(request, r));
      }

      const credRateLimitMatch = url.pathname.match(
        /^\/credentials\/([^/]+)\/report-rate-limit$/,
      );
      if (credRateLimitMatch && request.method === "POST") {
        return handleReportRateLimit(credRateLimitMatch[1]!, request).then((r) =>
          withCors(request, r),
        );
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

export function startServer(port: number = PORT, db?: Db) {
  // Initialize subsystems that need the DB
  if (db) {
    initNotificationRoutes(db);
    initCredentialRoutes(db);
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

        logger.debug("ws: open", {
          sessionId: ws.data.sessionId,
          mode: ws.data.mode,
        });
      },

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        const { sessionId, mode } = ws.data;

        if (mode !== "interact") {
          // Stream-only clients cannot send data
          return;
        }

        // JSON control frames (text)
        if (typeof msg === "string") {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
              const pty = streamManager.getPty(sessionId);
              if (pty) {
                pty.resize(parsed.cols, parsed.rows);
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

        logger.debug("ws: close", {
          sessionId: ws.data.sessionId,
          mode: ws.data.mode,
        });

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

  logger.info("nexus-agent started", { port: server.port });
  return server;
}
