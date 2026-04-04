import { logger } from "@nexus/core";
import os from "node:os";

const PORT = 7400;

/** Seconds since this process started. */
function uptimeSeconds(): number {
  return Math.floor(process.uptime());
}

/** Health payload with real hostname + uptime; metrics stubbed to 0. */
function healthPayload() {
  return {
    hostname: os.hostname(),
    uptime_seconds: uptimeSeconds(),
    cpu_percent: 0,
    ram_percent: 0,
    disk_percent: 0,
    docker_containers: 0,
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

/** Route dispatch. */
function handleRequest(request: Request): Response {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return withCors(request, new Response(null, { status: 204 }));
  }

  if (url.pathname === "/health") {
    const body = JSON.stringify(healthPayload());
    return withCors(
      request,
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  return withCors(
    request,
    new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export function startServer(port: number = PORT) {
  const server = Bun.serve({
    port,
    fetch: handleRequest,
  });

  logger.info("nexus-agent started", { port: server.port });
  return server;
}
