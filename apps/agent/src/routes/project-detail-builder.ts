/**
 * Project-detail route table builder — /project/:code/*.
 *
 * Handlers live in ./project-detail.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import {
  handleProjectStatus,
  handleProjectBeads,
  handleProjectGit,
  handleProjectSpecs,
  handleRunCommand,
} from "./project-detail";

export function buildProjectDetailRoutes(_db?: Db): Route[] {
  return [
    {
      method: "GET",
      path: "/project/:code/status",
      requiresDb: true,
      handler(req, params) {
        const url = new URL(req.url);
        return handleProjectStatus(params.code!, url);
      },
    },
    {
      method: "GET",
      path: "/project/:code/beads",
      requiresDb: true,
      handler(_req, params) {
        return handleProjectBeads(params.code!);
      },
    },
    {
      method: "GET",
      path: "/project/:code/git",
      requiresDb: true,
      handler(_req, params) {
        return handleProjectGit(params.code!);
      },
    },
    {
      method: "GET",
      path: "/project/:code/specs",
      requiresDb: true,
      handler(_req, params) {
        return handleProjectSpecs(params.code!);
      },
    },
    {
      method: "POST",
      path: "/project/:code/run",
      requiresDb: true,
      handler(req, params) {
        return handleRunCommand(params.code!, req);
      },
    },
  ];
}
