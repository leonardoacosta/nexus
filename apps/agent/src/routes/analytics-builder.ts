/**
 * Analytics route table builder.
 *
 * Handlers live in ./analytics.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import {
  handleAnalyticsHealth,
  handleAnalyticsSpecs,
  handleAnalyticsCredentials,
  handleAnalyticsGit,
  handleAnalyticsLifecycle,
  handleAnalyticsCron,
} from "./analytics";

export function buildAnalyticsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "GET",
      path: "/analytics/health",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsHealth(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/specs",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsSpecs(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/credentials",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsCredentials(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/git",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsGit(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/lifecycle",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsLifecycle(dbRef, url);
      },
    },
    {
      method: "GET",
      path: "/analytics/cron",
      requiresDb: true,
      handler(req) {
        const url = new URL(req.url);
        return handleAnalyticsCron(dbRef, url);
      },
    },
  ];
}
