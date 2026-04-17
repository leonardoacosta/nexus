/**
 * Spec route table builder — /specs/*.
 *
 * Handlers live in ./specs.ts. None of these routes require a DB.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 *
 * Route ordering note: the /specs/:project/:name/<action> routes MUST come
 * before /specs/:project/:name so the more-specific variants match first.
 */

import type { Route } from "../router";
import {
  handleGetSpecsAll,
  handleListSpecs,
  handleGetSpec,
  handleApproveSpec,
  handleRejectSpec,
  handleReadSpec,
  handleSpecStatus,
} from "./specs";

export function buildSpecsRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/specs/all",
      handler() {
        return handleGetSpecsAll();
      },
    },
    {
      method: "GET",
      path: "/specs",
      handler(req) {
        const url = new URL(req.url);
        return handleListSpecs(url);
      },
    },
    {
      method: "POST",
      path: "/specs/:project/:name/approve",
      handler(_req, params) {
        return handleApproveSpec(params.project!, params.name!);
      },
    },
    {
      method: "POST",
      path: "/specs/:project/:name/reject",
      handler(req, params) {
        return handleRejectSpec(params.project!, params.name!, req);
      },
    },
    {
      method: "POST",
      path: "/specs/:project/:name/read",
      handler(_req, params) {
        return handleReadSpec(params.project!, params.name!);
      },
    },
    {
      method: "GET",
      path: "/specs/:project/:name/status",
      handler(_req, params) {
        return handleSpecStatus(params.project!, params.name!);
      },
    },
    // This must come AFTER the more specific /specs/:project/:name/* routes
    // so that /approve, /reject, /read, /status are matched first.
    {
      method: "GET",
      path: "/specs/:project/:name",
      handler(_req, params) {
        return handleGetSpec(params.project!, params.name!);
      },
    },
  ];
}
