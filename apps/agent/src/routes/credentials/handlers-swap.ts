/**
 * Manual credential swap handler.
 *
 * - POST /credentials/swap { to: <name> }
 *
 * Looks up the target credential by name (not id), calls
 * `pool.manualSwap()`, emits paired `manual_swap_out`/`manual_swap_in`
 * audit entries, and strips `valueEncrypted` from the response.
 */

import type { ManualSwapResult } from "../../credentials/pool";
import {
  emitAudit,
  extractCallerIp,
  jsonResponse,
  poolRef,
} from "./shared";

/** POST /credentials/swap — manually swap the active credential by name. */
export async function handleSwapCredential(request: Request): Promise<Response> {
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

  const { to } = body as Record<string, unknown>;

  if (!to || typeof to !== "string") {
    return jsonResponse({ error: "'to' is required and must be a string" }, 400);
  }

  // Name → ID lookup: find credential whose name matches
  const allCredentials = await pool.list();
  const target = allCredentials.find((c) => c.name === to);

  if (!target) {
    return jsonResponse({ error: "credential not found", name: to }, 404);
  }

  const ip = extractCallerIp(request);

  let result: ManualSwapResult;
  try {
    const swapResult = await pool.manualSwap(target.id);
    if (!swapResult) {
      return jsonResponse({ error: "credential not found", name: to }, 404);
    }
    result = swapResult;
  } catch (err) {
    if (err instanceof Error && err.message === "target credential is in cooldown") {
      return jsonResponse({ error: "target credential is in cooldown", name: to }, 409);
    }
    throw err;
  }

  const now = new Date().toISOString();

  if (result.parked) {
    emitAudit({
      event: "credential.manual_swap_out",
      credential_id: result.parked.id,
      actor: "manual",
      ip,
      timestamp_iso: now,
    });
  }

  emitAudit({
    event: "credential.manual_swap_in",
    credential_id: result.activated.id,
    actor: "manual",
    ip,
    timestamp_iso: now,
  });

  const parked = result.parked
    ? (() => {
        const { valueEncrypted: _e, ...safe } = result.parked!;
        return safe;
      })()
    : null;

  const { valueEncrypted: _e, ...activatedSafe } = result.activated;

  return jsonResponse({ swapped: true, parked, activated: activatedSafe });
}
