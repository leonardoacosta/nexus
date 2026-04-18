/**
 * Settings route table builder.
 *
 * Covers agent CRUD: POST /agents, DELETE /agents/:id.
 * These endpoints let apps/nextjs delegate all agent-config writes through
 * the agent HTTP API instead of writing to the DB directly.
 *
 * Handlers live in ./settings.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import { handleSaveAgent, handleDeleteAgent } from "./settings";

export function buildSettingsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "POST",
      path: "/agents",
      requiresDb: true,
      handler(req) {
        return handleSaveAgent(dbRef, req);
      },
    },
    {
      method: "DELETE",
      path: "/agents/:id",
      requiresDb: true,
      handler(_req, params) {
        return handleDeleteAgent(dbRef, params.id!);
      },
    },
  ];
}
