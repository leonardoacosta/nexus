/**
 * Miscellaneous operational route table builder.
 *
 * Covers /environment, /failures, /cron. None require a DB.
 * Handlers live in ./environment-route.ts, ./failures-route.ts, ./cron-routes.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Route } from "../router";
import { handleEnvironment } from "./environment-route";
import { handleFailures } from "./failures-route";
import { handleCron } from "./cron-routes";

export function buildMiscRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/environment",
      handler() {
        return handleEnvironment();
      },
    },
    {
      method: "GET",
      path: "/failures",
      handler(req) {
        const url = new URL(req.url);
        return handleFailures(url);
      },
    },
    {
      method: "GET",
      path: "/cron",
      handler() {
        return handleCron();
      },
    },
  ];
}
