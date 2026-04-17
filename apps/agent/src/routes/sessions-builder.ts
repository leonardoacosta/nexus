/**
 * Session route table builder.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 * The handlers live in ./sessions.ts; this file only composes Route entries.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import {
  handleGetSessions,
  handleGetSessionById,
  handleSessionStart,
  handleGetSessionTokens,
} from "./sessions";

export function buildSessionsRoutes(_db?: Db): Route[] {
  const dbRef = _db as Db;

  return [
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
      path: "/sessions/:id/tokens",
      requiresDb: true,
      handler(_req, params) {
        return handleGetSessionTokens(dbRef, params.id!);
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
  ];
}
