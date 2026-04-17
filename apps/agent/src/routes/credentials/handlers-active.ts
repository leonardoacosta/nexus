/**
 * Active-credential handlers.
 *
 * - GET /credentials/active  — return the fingerprint of the credential
 *   currently at `~/.claude/.credentials.json` on the agent host.
 *
 * Data source: the in-memory snapshot maintained by
 * `startActiveCredentialWatcher()` in
 * `apps/agent/src/credentials/active-credential-watcher.ts`.
 */

import { credentialsActiveResponseSchema } from "@nexus/core";
import { getActiveCredentialSnapshot } from "../../credentials/credential-watcher";
import { jsonResponse } from "./shared";

/**
 * GET /credentials/active — return `{ fingerprint, resolvedPath, observedAt }`.
 *
 * `fingerprint` is null when the watcher has not yet observed a match
 * (agent just started, file missing, or fingerprint not in the pool).
 */
export async function handleGetActiveCredential(): Promise<Response> {
  const snap = getActiveCredentialSnapshot();
  const payload = credentialsActiveResponseSchema.parse({
    fingerprint: snap.fingerprint,
    resolvedPath: snap.resolvedPath,
    observedAt: snap.observedAt,
  });
  return jsonResponse(payload);
}
