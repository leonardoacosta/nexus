import type { Db } from "@nexus/db";
import { createLogger } from "@nexus/core";
import { fetchWithTimeout } from "@nexus/core/fetch";
import {
  CredentialPool,
  CredentialDeleteError,
} from "../credentials/pool";

// ── Audit logger ────────────────────────────────────────────────────────────

const auditLogger = createLogger("audit.credential");

/** Structured audit log entry for credential operations. */
type CredentialAuditEntry = {
  event: string;
  credential_id: string;
  actor: string;
  ip: string;
  timestamp_iso: string;
  detail?: Record<string, unknown>;
};

function emitAudit(entry: CredentialAuditEntry): void {
  auditLogger.info(entry, entry.event);
}

/** Extract caller IP from request headers or socket. */
function extractCallerIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  try {
    const { hostname } = new URL(request.url);
    return hostname || "unknown";
  } catch {
    return "unknown";
  }
}

// Singleton pool — initialized once via initCredentialRoutes()
let pool: CredentialPool | null = null;

/** Initialize credential routes with a database connection. */
export function initCredentialRoutes(
  db: Db,
  options?: {
    cooldownMs?: number;
    leaseTtlMs?: number;
    encryptionKey?: import("node:buffer").Buffer;
    prerotateThreshold?: number;
  },
): void {
  pool = new CredentialPool(db, options);
}

/** Get the pool (for testing). */
export function getCredentialPool(): CredentialPool | null {
  return pool;
}

/** Reset state (for testing). */
export function resetCredentialRoutes(): void {
  if (pool) pool.stopCleanup();
  pool = null;
}

// ── Loopback address detection ──────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackRequest(request: Request): boolean {
  try {
    const { hostname } = new URL(request.url);
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * TLS enforcement for credential submission (task 6.1).
 *
 * Requests arriving over http:// from non-loopback hosts are rejected with
 * 426 Upgrade Required. Loopback addresses (127.0.0.1, ::1, localhost) are
 * exempt for local integration tests and homelab deployments.
 *
 * The agent normally sits behind Traefik/Caddy with TLS termination, so
 * external traffic arrives with an https:// scheme in the forwarded URL.
 */
function checkTlsEnforcement(request: Request): Response | null {
  const { protocol } = new URL(request.url);
  if (protocol === "http:" && !isLoopbackRequest(request)) {
    return new Response(
      JSON.stringify({ error: "credentials must be submitted over TLS" }),
      {
        status: 426,
        headers: {
          "Content-Type": "application/json",
          Upgrade: "TLS/1.2, HTTPS",
        },
      },
    );
  }
  return null;
}

/** POST /credentials — add a new credential. */
export async function handleAddCredential(request: Request): Promise<Response> {
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

/** POST /credentials/lease — lease an available credential. */
export async function handleLeaseCredential(request: Request): Promise<Response> {
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
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const success = await pool.release(id);

  if (!success) {
    return jsonResponse({ error: "credential not found or not in leased state" }, 404);
  }

  return jsonResponse({ id, status: "available" });
}

/** GET /credentials — list all credentials (no values). */
export async function handleListCredentials(): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  return jsonResponse(await pool.list());
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

/**
 * POST /credentials/{id}/promote — promote a credential to primary within
 * its duplicate group.
 *
 * Returns 200 with the new group snapshot on success, 404 if the id is
 * unknown, 409 on cross-group drift. Idempotent: when the target is already
 * primary, `pool.promote()` returns `previousPrimary = null` and we skip
 * both the demote/promote update path AND the audit log emit, so callers
 * can retry safely without polluting the audit trail.
 */
export async function handlePromoteCredential(
  id: string,
  request: Request,
): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const ip = extractCallerIp(request);
  const actor =
    request.headers.get("x-nexus-actor") ??
    request.headers.get("x-forwarded-user") ??
    "system";

  let result: Awaited<ReturnType<CredentialPool["promote"]>>;
  try {
    result = await pool.promote(id);
  } catch (err) {
    if (err instanceof Error && err.message === "credential not found") {
      return jsonResponse({ error: "credential not found" }, 404);
    }
    if (
      err instanceof Error &&
      err.message === "cross-group promotion not allowed"
    ) {
      return jsonResponse(
        { error: "cross-group promotion not allowed" },
        409,
      );
    }
    throw err;
  }

  // Audit log only on real state change. Idempotent no-op (target was
  // already primary) returns previousPrimary === null and is silent.
  if (result.previousPrimary !== null) {
    emitAudit({
      event: "credential.promoted",
      credential_id: result.newPrimary,
      actor,
      ip,
      timestamp_iso: new Date().toISOString(),
      detail: { previous_primary: result.previousPrimary },
    });
  }

  return jsonResponse({
    id: result.newPrimary,
    duplicateGroupId: result.groupId,
    isPrimary: true,
    previousPrimary: result.previousPrimary,
  });
}

/** POST /credentials/{id}/report-rate-limit — report rate limit, trigger cooldown + rotation. */
export async function handleReportRateLimit(
  id: string,
  request: Request,
): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { leased_by } = body as Record<string, unknown>;

  if (!leased_by || typeof leased_by !== "string") {
    return jsonResponse({ error: "leased_by is required and must be a string" }, 400);
  }

  const ip = extractCallerIp(request);
  const result = await pool.reportRateLimit(id, leased_by as string);

  if (!result) {
    return jsonResponse({ error: "credential not found" }, 404);
  }

  const now = new Date().toISOString();

  emitAudit({
    event: "credential.cooldown",
    credential_id: result.cooledDown.id,
    actor: leased_by as string,
    ip,
    timestamp_iso: now,
  });

  if (result.next) {
    emitAudit({
      event: "credential.auto_swap",
      credential_id: result.next.id,
      actor: leased_by as string,
      ip,
      timestamp_iso: now,
      detail: { cooled_id: result.cooledDown.id },
    });
  }

  const { valueEncrypted: _e1, ...cooledDown } = result.cooledDown;
  const next = result.next
    ? (() => {
        const { valueEncrypted: _e2, ...safe } = result.next!;
        return { ...safe, value: result.next!.valueEncrypted };
      })()
    : null;

  return jsonResponse({ cooled_down: cooledDown, next });
}

/**
 * GET /credentials/{id}/health — check if a credential is valid/revoked.
 *
 * Decrypts the credential, calls the Anthropic usage API, and returns
 * { healthy: boolean, checked_at: string }.
 */
export async function handleCredentialHealth(id: string, request: Request): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  // Use lease to get the decrypted credential value
  // We directly look up via internal pool mechanism
  const credential = await pool.getDecrypted(id);
  if (!credential) {
    return jsonResponse({ error: "credential not found" }, 404);
  }

  const checked_at = new Date().toISOString();
  const ip = extractCallerIp(request);
  try {
    const response = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        "anthropic-version": "2023-06-01",
      },
      timeout: 10_000,
    });
    // 200 or 401/403 are both "valid credential" responses (credential reached the API)
    // true healthy = API accepts token; false = revoked/invalid
    const healthy = response.status !== 401 && response.status !== 403;

    emitAudit({
      event: "credential.health_check",
      credential_id: id,
      actor: "system",
      ip,
      timestamp_iso: checked_at,
      detail: { healthy, checked_at },
    });

    return jsonResponse({ healthy, checked_at });
  } catch {
    return jsonResponse({ error: "health check failed — could not reach Anthropic API" }, 500);
  }
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
