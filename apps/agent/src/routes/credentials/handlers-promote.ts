/**
 * Promote / rate-limit / auto-swap handlers.
 *
 * - POST /credentials/:id/promote
 * - POST /credentials/:id/report-rate-limit
 */

import type { CredentialPool } from "../../credentials/pool";
import {
  emitAudit,
  extractCallerIp,
  jsonResponse,
  poolRef,
} from "./shared";

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
  const pool = poolRef.current;
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
