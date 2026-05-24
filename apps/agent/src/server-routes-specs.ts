/**
 * Spec + command route dispatch extracted from server-request-handler.ts.
 *
 * Covers GET /specs, GET /specs/all, parameterised /specs/:project/:name/*,
 * and /commands, /commands/:name.
 */

import { logger } from "@nexus/core/node";
import type { Db } from "@nexus/db";
import {
  handleGetSpecsAll,
  handleListSpecs,
  handleGetSpec,
  handleGetSpecContent,
  handleApproveSpec,
  handleRejectSpec,
  handleReadSpec,
  handleSpecStatus,
} from "./routes/specs";
import { handleSpecEventsStream } from "./routes/specs-events";
import { handleListSpecSessions } from "./routes/specs/handlers-sessions";
import { handlePatchSpecStatus } from "./routes/specs/handlers-status";
import {
  handleListCommands,
  handleListCommandsByNamespace,
  handleUpdateCommand,
} from "./routes/commands";
import { handleSendText } from "./routes/commands-send-text";
import { handleResize } from "./routes/commands-resize";
import { withCors } from "./server-origin";

/**
 * Try to match and handle a spec route.
 *
 * Returns a Response (or Promise<Response>) when the URL matches, else null.
 *
 * `db` is optional: spec routes added by specs-tab-start-on-spec (the
 * `sessions` listing and the `status` PATCH) require it; older read-only
 * routes work without. When `db` is undefined those new routes fall
 * through to null so the dispatcher's 404 path takes over (matches the
 * legacy "no DB → no DB-dependent surface" contract).
 */
export function tryHandleSpecRoute(
  request: Request,
  url: URL,
  db?: Db,
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

  // PATCH /specs/:project/:name/status — flip frontmatter status atomically.
  // Registered BEFORE the `/specs/:project/:name/:file` catch-all so the
  // literal `status` segment isn't classified as a markdown filename. The
  // archived-spec short-circuit (409) lives inside the handler — see
  // handlers-status.ts § 409 short-circuit. specs-tab-start-on-spec § 2.6.
  if (specStatusMatch && request.method === "PATCH" && db) {
    return handlePatchSpecStatus(specStatusMatch[1]!, specStatusMatch[2]!, request)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error({ route: "/specs/:project/:name/status", method: "PATCH", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
  }

  // GET /specs/:project/:name/sessions — historical + live linked sessions.
  // Registered BEFORE the catch-all so the literal `sessions` segment isn't
  // mistaken for a markdown file. specs-tab-start-on-spec § 2.4.
  const specSessionsMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)\/sessions$/);
  if (specSessionsMatch && request.method === "GET" && db) {
    return handleListSpecSessions(db, specSessionsMatch[1]!, specSessionsMatch[2]!)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error({ route: "/specs/:project/:name/sessions", method: "GET", err }, "route handler failed");
        return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      });
  }

  // GET /specs/:project/:name/:file — raw markdown content (proposal/design/tasks).
  // Matched AFTER the typed verbs above so `/approve`, `/reject`, `/read`,
  // `/status` are not mis-classified as a content file.
  // Spec: dashboard-ui-pass-v1 (task 1.2)
  const specContentMatch = url.pathname.match(/^\/specs\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (specContentMatch && request.method === "GET") {
    return handleGetSpecContent(
      specContentMatch[1]!,
      specContentMatch[2]!,
      specContentMatch[3]!,
    ).then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/specs/:project/:name/:file", method: "GET", err }, "route handler failed");
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

  // POST /commands/send-text — forward text to a session's tmux pane.
  // Used by the watchOS notification action handlers + future iOS quick-reply.
  // Matched before /commands/:name so "send-text" is not treated as a namespace.
  if (url.pathname === "/commands/send-text" && request.method === "POST") {
    return handleSendText(request).then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/commands/send-text", method: "POST", err }, "route handler failed");
      return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    });
  }

  // POST /commands/resize — viewer-driven take-over resize of a session PTY.
  // Managed-gated server-side. Matched before /commands/:name so "resize" is
  // not treated as a namespace. (pty-adaptive-geometry-fullscreen task 1.5)
  if (url.pathname === "/commands/resize" && request.method === "POST") {
    return handleResize(request).then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/commands/resize", method: "POST", err }, "route handler failed");
      return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    });
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
