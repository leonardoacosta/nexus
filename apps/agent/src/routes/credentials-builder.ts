/**
 * Credential route table builder.
 *
 * Handlers live in ./credentials.ts (which task 1.4 will split further).
 * This file is intentionally kept separate from ./credentials.ts so the
 * two splits can proceed independently without merge conflict.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import {
  handleAddCredential,
  handleLeaseCredential,
  handleReleaseCredential,
  handleListCredentials,
  handleReportRateLimit,
  handleCredentialHealth,
  handleDeleteCredential,
  handlePromoteCredential,
  handleCredentialUsage,
  handleSwapCredential,
  handleGetActiveCredential,
} from "./credentials";

// ── Credential ID validation ────────────────────────────────────────────────
const CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate a credential ID path parameter. Returns a 400 Response or null. */
function validateCredentialId(id: string): Response | null {
  if (!CREDENTIAL_ID_RE.test(id)) {
    return new Response("Bad Request", { status: 400 });
  }
  return null;
}

export function buildCredentialsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "POST",
      path: "/credentials",
      requiresDb: true,
      handler(req) {
        return handleAddCredential(req);
      },
    },
    {
      method: "GET",
      path: "/credentials",
      requiresDb: true,
      handler() {
        return handleListCredentials();
      },
    },
    // GET /credentials/active — active-for-Claude-Code fingerprint snapshot.
    // Registered before parameterised `/credentials/:id/...` routes so the
    // reserved literal `active` is matched here rather than as an id.
    {
      method: "GET",
      path: "/credentials/active",
      requiresDb: true,
      handler() {
        return handleGetActiveCredential();
      },
    },
    {
      method: "POST",
      path: "/credentials/lease",
      requiresDb: true,
      handler(req) {
        return handleLeaseCredential(req);
      },
    },
    // Credential usage endpoint (session-token-stream)
    {
      method: "GET",
      path: "/credentials/:id/usage",
      requiresDb: true,
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleCredentialUsage(dbRef, params.id!, req);
      },
    },
    // Credential parameterized routes are NOT gated by requiresDb so that
    // credential ID validation (returning 400 for malformed IDs) runs even
    // when no DB is configured.  The handlers themselves check for pool
    // initialization and return 500 if not ready.
    {
      method: "POST",
      path: "/credentials/:id/release",
      handler(_req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleReleaseCredential(params.id!);
      },
    },
    {
      method: "POST",
      path: "/credentials/:id/report-rate-limit",
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleReportRateLimit(params.id!, req);
      },
    },
    {
      method: "GET",
      path: "/credentials/:id/health",
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleCredentialHealth(params.id!, req);
      },
    },
    // credential-identity: delete a credential (with orphan protection on
    // primary-of-multi-member-group, gated by ?promote=<sibling_id>).
    {
      method: "DELETE",
      path: "/credentials/:id",
      requiresDb: true,
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handleDeleteCredential(params.id!, req);
      },
    },
    // credential-identity: promote a credential to primary within its
    // duplicate group (idempotent — already-primary is a 200 no-op).
    {
      method: "POST",
      path: "/credentials/:id/promote",
      requiresDb: true,
      handler(req, params) {
        const badId = validateCredentialId(params.id!);
        if (badId) return badId;
        return handlePromoteCredential(params.id!, req);
      },
    },
    {
      method: "GET",
      path: "/credentials/status",
      requiresDb: true,
      handler() {
        return handleListCredentials();
      },
    },
    // credential-swap: manual account switch by name
    {
      method: "POST",
      path: "/credentials/swap",
      requiresDb: true,
      handler(req) {
        return handleSwapCredential(req);
      },
    },
  ];
}
