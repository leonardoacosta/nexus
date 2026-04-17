/**
 * Lease/release handlers.
 *
 * - POST /credentials/lease
 * - POST /credentials/:id/release
 */

import {
  emitAudit,
  extractCallerIp,
  jsonResponse,
  poolRef,
} from "./shared";

/** POST /credentials/lease — lease an available credential. */
export async function handleLeaseCredential(request: Request): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { type, leased_by } = body as Record<string, unknown>;

  if (!type || typeof type !== "string") {
    return jsonResponse({ error: "type is required and must be a string" }, 400);
  }
  if (!leased_by || typeof leased_by !== "string") {
    return jsonResponse({ error: "leased_by is required and must be a string" }, 400);
  }

  const ip = extractCallerIp(request);
  const credential = await pool.lease(type as string, leased_by as string);

  if (!credential) {
    return jsonResponse({ error: "no available credentials of this type" }, 409);
  }

  emitAudit({
    event: "credential.leased",
    credential_id: credential.id,
    actor: leased_by as string,
    ip,
    timestamp_iso: new Date().toISOString(),
    detail: { type: credential.type },
  });

  // Strip encrypted storage column — caller receives decrypted value via valueEncrypted
  const { valueEncrypted: _e, ...safe } = credential;
  return jsonResponse({ ...safe, value: credential.valueEncrypted });
}

/** POST /credentials/{id}/release — release a leased credential. */
export async function handleReleaseCredential(id: string): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const success = await pool.release(id);

  if (!success) {
    return jsonResponse({ error: "credential not found or not in leased state" }, 404);
  }

  return jsonResponse({ id, status: "available" });
}
