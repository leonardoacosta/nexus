/**
 * Operational route table builder — statusline, hooks, recommend.
 *
 * Handlers live in ./statusline.ts, ./hooks.ts, ./recommend.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import { handleStatusline } from "./statusline";
import { handleHooks } from "./hooks";
import { handleRecommend } from "./recommend";

export function buildOperationalRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "GET",
      path: "/statusline",
      requiresDb: true,
      handler() {
        return handleStatusline(dbRef);
      },
    },
    {
      method: "POST",
      path: "/hooks",
      requiresDb: true,
      handler(req) {
        return handleHooks(dbRef, req);
      },
    },
    {
      method: "GET",
      path: "/recommend",
      requiresDb: true,
      handler() {
        return handleRecommend(dbRef);
      },
    },
  ];
}
