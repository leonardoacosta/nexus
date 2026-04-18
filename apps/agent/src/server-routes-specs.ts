/**
 * Spec + command route dispatch extracted from server-request-handler.ts.
 *
 * Covers GET /specs, GET /specs/all, parameterised /specs/:project/:name/*,
 * and /commands, /commands/:name.
 */

import { logger } from "@nexus/core/node";
import {
  handleGetSpecsAll,
  handleListSpecs,
  handleGetSpec,
  handleApproveSpec,
  handleRejectSpec,
  handleReadSpec,
  handleSpecStatus,
} from "./routes/specs";
import { handleSpecEventsStream } from "./routes/specs-events";
import {
  handleListCommands,
  handleListCommandsByNamespace,
  handleUpdateCommand,
} from "./routes/commands";
import { withCors } from "./server-origin";

/**
 * Try to match and handle a spec route.
 *
 * Returns a Response (or Promise<Response>) when the URL matches, else null.
 */
export function tryHandleSpecRoute(
  request: Request,
  url: URL,
): Response | Promise<Response> | null {
  if (url.pathname === "/specs/all" && request.method === "GET") {
    return handleGetSpecsAll().then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/specs/all", method: "GET", err }, "route handler failed");
      return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    });
  }

  // GET /specs/events — SSE stream of spec transitions. Must be handled
  // before the parameterised /specs/:project/:name/* routes so the
  // literal `events` segment does not match as a project code.
  if (url.pathname === "/specs/events" && request.method === "GET") {
    try {
      return withCors(request, handleSpecEventsStream());
    } catch (err) {
      logger.error({ route: "/specs/events", method: "GET", err }, "route handler failed");
      return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    }
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

  return null;
}

/**
 * Try to match and handle a /commands route.
 *
 * Returns a Response (or Promise<Response>) when the URL matches, else null.
 */
export function tryHandleCommandRoute(
  request: Request,
  url: URL,
): Response | Promise<Response> | null {
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

  return null;
}
