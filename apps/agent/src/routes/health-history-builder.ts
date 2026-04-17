/**
 * Health-history route table builder.
 *
 * Handler lives in ./health-history.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import { handleGetHealthHistory } from "./health-history";

export function buildHealthHistoryRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "GET",
      path: "/health/history",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleGetHealthHistory(dbRef, url);
      },
    },
  ];
}
