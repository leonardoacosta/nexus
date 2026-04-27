/**
 * ElevenLabs route dispatch extracted from server-request-handler.ts.
 *
 * Mirrors the shape of `server-routes-credentials.ts` for the OAuth pool —
 * five DB-backed routes dispatched by `server-request-handler.ts` (the
 * legacy `x-nexus-secret` middleware was removed by `drop-attach-secret-gate`;
 * reach is now bounded at the bind layer).
 *
 * Routes:
 *   GET    /elevenlabs/credentials       — masked status
 *   PATCH  /elevenlabs/credentials       — partial upsert (validated via Zod)
 *   DELETE /elevenlabs/credentials       — drops the row
 *   POST   /elevenlabs/credentials/test  — proxies /v1/user
 *   GET    /elevenlabs/voices            — cached voice list
 *
 * All five require a Db handle; when `db` is undefined the dispatcher
 * returns null so the caller falls through to the not-found branch.
 *
 * Spec: openspec/changes/harden-elevenlabs-credential-p2-p3-gcf/
 */

import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import {
  handleGetCredentials,
  handlePatchCredentials,
  handleDeleteCredentials,
  handleTestConnection,
} from "./routes/elevenlabs-credentials";
import { handleListVoices } from "./routes/elevenlabs-voices";
import { withCors } from "./server-origin";

/**
 * Try to match and handle an elevenlabs route.
 *
 * Returns a Response (or Promise<Response>) when the URL matches, or `null`
 * when it does not — callers should fall through to further matching.
 */
export function tryHandleElevenlabsRoute(
  request: Request,
  url: URL,
  db?: Db,
): Response | Promise<Response> | null {
  // Without a DB no elevenlabs route can run; return null so the outer
  // dispatcher falls through to the not-found branch rather than 500-ing.
  if (!db) return null;

  if (
    url.pathname === "/elevenlabs/credentials" &&
    request.method === "GET"
  ) {
    return handleGetCredentials(db, request)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error(
          { route: "/elevenlabs/credentials", method: "GET", err },
          "route handler failed",
        );
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
  }

  if (
    url.pathname === "/elevenlabs/credentials" &&
    request.method === "PATCH"
  ) {
    return handlePatchCredentials(db, request)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error(
          { route: "/elevenlabs/credentials", method: "PATCH", err },
          "route handler failed",
        );
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
  }

  if (
    url.pathname === "/elevenlabs/credentials" &&
    request.method === "DELETE"
  ) {
    return handleDeleteCredentials(db, request)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error(
          { route: "/elevenlabs/credentials", method: "DELETE", err },
          "route handler failed",
        );
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
  }

  if (
    url.pathname === "/elevenlabs/credentials/test" &&
    request.method === "POST"
  ) {
    return handleTestConnection(db, request)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error(
          { route: "/elevenlabs/credentials/test", method: "POST", err },
          "route handler failed",
        );
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
  }

  if (url.pathname === "/elevenlabs/voices" && request.method === "GET") {
    return handleListVoices(db, request)
      .then((r) => withCors(request, r))
      .catch((err) => {
        logger.error(
          { route: "/elevenlabs/voices", method: "GET", err },
          "route handler failed",
        );
        return withCors(
          request,
          new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
  }

  return null;
}
