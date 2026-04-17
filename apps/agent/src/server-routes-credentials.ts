/**
 * Credential route dispatch extracted from server-request-handler.ts.
 *
 * Covers POST/GET /credentials, /credentials/lease, /credentials/status, and
 * path-parameterised /credentials/:id/{release,report-rate-limit,health}.
 * Each handler is pre-gated by `CREDENTIAL_ID_RE` when the id is path-bound.
 */

import { logger } from "@nexus/core";
import {
  handleAddCredential,
  handleLeaseCredential,
  handleReleaseCredential,
  handleListCredentials,
  handleReportRateLimit,
  handleCredentialHealth,
  handleGetActiveCredential,
} from "./routes/credentials";
import { withCors } from "./server-origin";
import { CREDENTIAL_ID_RE } from "./server-auth";

/**
 * Try to match and handle a credential route.
 *
 * Returns a Response (or Promise<Response>) when the URL matches a credential
 * route, or `null` when it does not. Callers should fall through to further
 * route matching when `null` is returned.
 */
export function tryHandleCredentialRoute(
  request: Request,
  url: URL,
): Response | Promise<Response> | null {
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

  // GET /credentials/active — active-for-Claude-Code fingerprint snapshot.
  // Must appear before parameterised `/credentials/:id/...` routes so the
  // reserved word `active` does not match the id regex.
  if (url.pathname === "/credentials/active" && request.method === "GET") {
    return handleGetActiveCredential().then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/credentials/active", method: "GET", err }, "route handler failed");
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

  return null;
}
