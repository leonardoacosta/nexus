/**
 * Events route table builders.
 *
 * Split into two builders to preserve the original declaration order
 * where `/events` (DB-guarded) appears before project-detail routes and
 * `/events/stream` (no DB) appears at the very end of the route table.
 *
 * Handlers live in ./events-sse.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import { handleGetEvents, handleEventsStream } from "./events-sse";

/** GET /events — DB-guarded event list (declared mid-table). */
export function buildEventsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "GET",
      path: "/events",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleGetEvents(dbRef, url);
      },
    },
  ];
}

/** GET /events/stream — SSE stream, no DB required (declared last). */
export function buildEventsStreamRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/events/stream",
      handler() {
        return handleEventsStream();
      },
    },
  ];
}
