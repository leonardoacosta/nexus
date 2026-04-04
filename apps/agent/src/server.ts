import type { Database } from "bun:sqlite";
import { logger } from "@nexus/core";
import type { HealthMetrics } from "@nexus/core";
import os from "node:os";
import { handleGetSessions, handleGetSessionById } from "./routes/sessions";
import { handleGetProjects } from "./routes/projects";
import { HealthCollector } from "./health-collector";

const PORT = 7400;

const healthCollector = new HealthCollector();
healthCollector.start();

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

/** Create the route dispatch handler, optionally backed by a SQLite DB. */
function createRequestHandler(db?: Database) {
  return function handleRequest(request: Request): Response {
    const url = new URL(request.url);

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
        return withCors(request, handleGetSessions(db, url));
      }

      // GET /sessions/{id}
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (sessionMatch && request.method === "GET") {
        return withCors(request, handleGetSessionById(db, sessionMatch[1]!));
      }

      // GET /projects
      if (url.pathname === "/projects" && request.method === "GET") {
        return withCors(request, handleGetProjects(db));
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

export { healthCollector };

export function startServer(port: number = PORT, db?: Database) {
  const server = Bun.serve({
    port,
    fetch: createRequestHandler(db),
  });

  logger.info("nexus-agent started", { port: server.port });
  return server;
}
