/**
 * Projects route table builder.
 *
 * Covers /projects, /projects/discovered, /agent/self.
 * Handlers live in ./projects.ts, ./projects-discovered.ts, ./agent-self.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import { handleGetProjects } from "./projects";
import { handleGetAgentSelf } from "./agent-self";
import { handleGetDiscoveredProjects } from "./projects-discovered";

export function buildProjectsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "GET",
      path: "/projects",
      requiresDb: true,
      handler(req) {
        return handleGetProjects(dbRef, new URL(req.url));
      },
    },
    {
      method: "GET",
      path: "/agent/self",
      requiresDb: true,
      handler() {
        return handleGetAgentSelf(dbRef);
      },
    },
    {
      method: "GET",
      path: "/projects/discovered",
      requiresDb: true,
      handler(req) {
        return handleGetDiscoveredProjects(dbRef, new URL(req.url));
      },
    },
  ];
}
