/**
 * Command route table builder — /commands, /commands/:name.
 *
 * Handlers live in ./commands.ts. None of these routes require a DB.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Route } from "../router";
import {
  handleListCommands,
  handleListCommandsByNamespace,
  handleUpdateCommand,
} from "./commands";

export function buildCommandsRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/commands",
      handler(req) {
        const url = new URL(req.url);
        return handleListCommands(url);
      },
    },
    {
      method: "GET",
      path: "/commands/:name",
      handler(_req, params) {
        // Router already decodes path params via decodeURIComponent
        return handleListCommandsByNamespace(params.name!);
      },
    },
    {
      method: "PUT",
      path: "/commands/:name",
      handler(req, params) {
        // Router already decodes path params via decodeURIComponent
        return handleUpdateCommand(params.name!, req);
      },
    },
  ];
}
