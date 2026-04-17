/**
 * CRUD handlers: add / list / delete credentials.
 *
 * - POST /credentials
 * - GET /credentials
 * - DELETE /credentials/:id
 */

import { CredentialDeleteError } from "../../credentials/pool";
import { getActiveCredentialSnapshot } from "../../credentials/credential-watcher";
import {
  checkTlsEnforcement,
  emitAudit,
  extractCallerIp,
  jsonResponse,
  poolRef,
} from "./shared";

/** POST /credentials — add a new credential. */
export async function handleAddCredential(request: Request): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  // TLS enforcement: reject non-loopback HTTP requests with 426
  const tlsErr = checkTlsEnforcement(request);
  if (tlsErr) return tlsErr;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { id, name, type, value } = body as Record<string, unknown>;

  if (!id || typeof id !== "string") {
    return jsonResponse({ error: "id is required and must be a string" }, 400);
  }
  if (!name || typeof name !== "string") {
    return jsonResponse({ error: "name is required and must be a string" }, 400);
  }
  if (!type || typeof type !== "string") {
    return jsonResponse({ error: "type is required and must be a string" }, 400);
  }
  if (!value || typeof value !== "string") {
    return jsonResponse({ error: "value is required and must be a string" }, 400);
  }

  try {
    await pool.add({
      id: id as string,
      name: name as string,
      type: type as string,
      value_plaintext: value as string,
    });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "failed to add credential" },
      409,
    );
  }

  return jsonResponse({ id, name, type, status: "available" }, 201);
}

/**
 * GET /credentials — list all credentials (no values).
 *
 * Response shape (envelope):
 *   {
 *     credentials: CredentialListEntry[],
 *     activeFingerprint: string | null
 *   }
 *
 * `activeFingerprint` mirrors `GET /credentials/active` and is merged in here
 * so the dashboard can render the active-account indicator on first load
 * without a second round trip. The value comes from the in-memory snapshot
 * maintained by `startActiveCredentialWatcher()`.
 */
export async function handleListCredentials(): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const [credentials, snap] = await Promise.all([
    pool.list(),
    Promise.resolve(getActiveCredentialSnapshot()),
  ]);

  return jsonResponse({
    credentials,
    activeFingerprint: snap.fingerprint,
  });
}

/**
 * DELETE /credentials/{id} — delete a credential row.
 *
 * Reads `?promote=<sibling_id>` from the URL query string. Returns 404 when
 * the id does not exist, 204 on success.
 */
export async function handleDeleteCredential(
  id: string,
  request: Request,
): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const url = new URL(request.url);
  const promoteId = url.searchParams.get("promote") ?? undefined;
  const ip = extractCallerIp(request);
  const actor =
    request.headers.get("x-nexus-actor") ??
    request.headers.get("x-forwarded-user") ??
    "system";

  try {
    await pool.deleteById(id, promoteId ? { promoteId } : undefined);
  } catch (err) {
    if (err instanceof CredentialDeleteError) {
      return jsonResponse(
        {
          error:
            "must specify ?promote=<sibling_id> when deleting primary of multi-member group",
          code: err.code,
          siblings: err.siblings,
        },
        409,
      );
    }
    if (err instanceof Error && err.message === "credential not found") {
      return jsonResponse({ error: "credential not found" }, 404);
    }
    throw err;
  }

  emitAudit({
    event: "credential.deleted",
    credential_id: id,
    actor,
    ip,
    timestamp_iso: new Date().toISOString(),
    detail: promoteId ? { promoted_to: promoteId } : undefined,
  });

  return new Response(null, { status: 204 });
}
