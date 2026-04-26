/**
 * ElevenLabs route group builder.
 *
 * Five routes, all DB-required, all gated by `x-nexus-secret` (applied at
 * the global middleware in `server-request-handler.ts`).
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import {
  handleGetCredentials,
  handlePatchCredentials,
  handleDeleteCredentials,
  handleTestConnection,
} from "./elevenlabs-credentials";
import { handleListVoices } from "./elevenlabs-voices";

export function buildElevenlabsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;
  return [
    {
      method: "GET",
      path: "/elevenlabs/credentials",
      requiresDb: true,
      handler(req) {
        return handleGetCredentials(dbRef, req);
      },
    },
    {
      method: "PATCH",
      path: "/elevenlabs/credentials",
      requiresDb: true,
      handler(req) {
        return handlePatchCredentials(dbRef, req);
      },
    },
    {
      method: "DELETE",
      path: "/elevenlabs/credentials",
      requiresDb: true,
      handler(req) {
        return handleDeleteCredentials(dbRef, req);
      },
    },
    {
      method: "POST",
      path: "/elevenlabs/credentials/test",
      requiresDb: true,
      handler(req) {
        return handleTestConnection(dbRef, req);
      },
    },
    {
      method: "GET",
      path: "/elevenlabs/voices",
      requiresDb: true,
      handler(req) {
        return handleListVoices(dbRef, req);
      },
    },
  ];
}
