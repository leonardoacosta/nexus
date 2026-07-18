/**
 * CRUD handlers: add / list / delete credentials.
 *
 * - POST /credentials
 * - GET /credentials
 * - DELETE /credentials/:id
 */

import { CredentialDeleteError } from "../../credentials/pool";
import { getActiveCredentialSnapshot } from "../../credentials/credential-watcher";
import { readCredentials } from "../../services/credential-pool/reader";
import { count24h } from "../../services/credential-pool/rate-limit-tracker";
import { lastSwapAt as swapTrackerLastSwapAt } from "../../services/credential-pool/swap-tracker";
import { resolveSessionAccountUsage } from "../../services/session-credential-resolve";
import { getSessionByCcSessionId } from "../../db/sessions";
import {
  credentialsSessionIdQuery,
  credentialsSessionUsageSchema,
} from "@nexus/core";
import type { CredentialsSessionUsage } from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import {
  checkTlsEnforcement,
  emitAudit,
  extractCallerIp,
  jsonResponse,
  poolRef,
  dbRef,
} from "./shared";

const log = createLogger("agent:routes:credentials:crud");

/**
 * Parse the optional `?sessionId=` query param off `request`. Returns `null`
 * when absent, blank, or the request/URL is unusable — every failure mode
 * degrades to "no session-scoped resolution attempted" rather than an error,
 * matching the `?dedupe=true` param's existing fail-open convention below.
 */
function parseSessionIdParam(request?: Request): string | null {
  if (!request) return null;
  try {
    const url = new URL(request.url);
    const parsed = credentialsSessionIdQuery.safeParse({
      sessionId: url.searchParams.get("sessionId"),
    });
    return parsed.success ? parsed.data.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the additive `sessionUsage` field for `GET /credentials?sessionId=`.
 *
 * Reuses `resolveSessionAccountUsage` — the exact same resolution
 * `GET /statusline?sessionId=` composes (`../statusline.ts`'s
 * `buildSessionStatus`) — rather than re-deriving session→credential
 * resolution a second time. See that module's doc for the resolution order
 * (explicit `sessions.credentialId` binding, else the requesting agent's own
 * live active-credential snapshot when the session's machine matches this
 * process) and its honest limitation (no live signal for a session on a
 * different machine than the one serving this request).
 *
 * Always returns a fully-populated `CredentialsSessionUsage` — `accountId`/
 * `fiveHour`/`sevenDay` are `null` together when the session is unknown or
 * unresolved; there is no separate "not found" status because `GET
 * /credentials` has always been a 200-only endpoint and this addition
 * preserves that.
 */
async function buildSessionUsage(
  sessionId: string,
): Promise<CredentialsSessionUsage> {
  const unresolved: CredentialsSessionUsage = {
    sessionId,
    accountId: null,
    fiveHour: null,
    sevenDay: null,
  };

  const db = dbRef.current;
  if (!db) return unresolved;

  // `sessionId` is CC's own raw hook session id (universe 2 — the same value
  // cc-tmux/context-guard.ts send), NOT nx's internal `sessions.id` primary
  // key (universe 1) — see `getSessionByCcSessionId`'s doc
  // (fix-cc-session-id-bridge, nx-22xz8). `getSessionById` queries the
  // primary key and would only match by id/ccSessionId coincidence.
  const session = await getSessionByCcSessionId(db, sessionId);
  if (!session) return unresolved;

  const acct = await resolveSessionAccountUsage(db, session);
  if (!acct) return unresolved;

  return credentialsSessionUsageSchema.parse({
    sessionId,
    accountId: acct.accountId,
    fiveHour: acct.fiveHour,
    sevenDay: acct.sevenDay,
  });
}

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
 * without a second round trip.
 *
 * Resolution cascade (homelab-emits-specs-credentials task 1.8):
 *   1. DB-backed pool (`pool.list()` + `getActiveCredentialSnapshot()`).
 *      This is the canonical path once credentials have been imported into
 *      the agent's nexus.db.
 *   2. Filesystem reader (`readCredentials()`) — falls back when the pool
 *      is uninitialized OR returns zero rows. This surfaces the homelab's
 *      `~/.config/nexus/credentials/acct-*.json` pool entries without
 *      waiting for the credential-watcher to populate the DB.
 *
 * The fallback exists because deploys with an unseeded DB and no
 * credential-watcher pass yet would otherwise show "no credentials" even
 * though the operator has acct-*.json files on disk.
 *
 * `?sessionId=<id>` (optional, nullable): when present, an ADDITIVE
 * `sessionUsage` field is merged into the envelope carrying the 5H/7D usage
 * for the account actually driving that session (see `buildSessionUsage`
 * above). Absent when the param is not given — every existing caller's
 * response shape is byte-for-byte unchanged. This applies uniformly across
 * both the pool path and the filesystem-fallback path below, and regardless
 * of `?dedupe=`.
 */
export async function handleListCredentials(
  request?: Request,
): Promise<Response> {
  const pool = poolRef.current;

  // `?dedupe=true` collapses the response to primaries only, with each row
  // carrying `siblingCount` / `siblingIds[]` describing the hidden duplicates.
  // Default behaviour (no query param) returns every row byte-for-byte the
  // same as before for back-compat.
  const dedupe = (() => {
    if (!request) return false;
    try {
      const url = new URL(request.url);
      return url.searchParams.get("dedupe") === "true";
    } catch {
      return false;
    }
  })();

  const sessionIdParam = parseSessionIdParam(request);
  const sessionUsage = sessionIdParam
    ? await buildSessionUsage(sessionIdParam)
    : undefined;
  const sessionUsageField = sessionUsage ? { sessionUsage } : {};

  // Pool path: try the DB-backed listing first.
  if (pool) {
    try {
      const [credentials, snap] = await Promise.all([
        pool.list(),
        Promise.resolve(getActiveCredentialSnapshot()),
      ]);

      if (credentials.length > 0) {
        // Enrich each DB-backed row with the runtime-only signals the Swift
        // CcProfile struct requires: rateLimit429Count (Int), isActive (Bool),
        // lastSwapAt (Date?). The DB row already carries id/name/fingerprint/
        // subscriptionType/rateLimitTier/expiresAt/accountEmail/accountName/
        // orgName/status — those pass through untouched so existing callers
        // (CLI/curl) keep the legacy fields.
        //
        // The seven usage_* columns added by
        // `credentials-account-resolve-and-usage` (usage5hUsed, usage5hLimit,
        // usage5hResetAt, etc. + usagePolledAt) ride through via the
        // top-level spread — null until the poller has sampled the row.
        const activeFp = snap.fingerprint;
        const enriched = credentials.map((row) => {
          const fp = row.fingerprint ?? "";
          const swapAt = fp ? swapTrackerLastSwapAt(fp) : null;
          return {
            ...row,
            rateLimit429Count: fp ? count24h(fp) : 0,
            isActive: fp.length > 0 && fp === activeFp,
            lastSwapAt: swapAt ? swapAt.toISOString() : null,
          };
        });

        if (dedupe) {
          // Build the duplicate-group index from the full enriched list, then
          // emit only the primaries (each carrying `siblingCount` +
          // `siblingIds`). Rows without a duplicate_group_id fall back to
          // their fingerprint, then to a synthetic key, matching the
          // primary-attach logic in `pool.list()`.
          const groupIndex = new Map<string, typeof enriched>();
          for (const row of enriched) {
            const key =
              row.duplicateGroupId ?? row.fingerprint ?? `__id:${row.id}`;
            const bucket = groupIndex.get(key) ?? [];
            bucket.push(row);
            groupIndex.set(key, bucket);
          }
          const collapsed = enriched
            .filter((row) => row.isPrimary === true)
            .map((row) => {
              const key =
                row.duplicateGroupId ?? row.fingerprint ?? `__id:${row.id}`;
              const siblings = (groupIndex.get(key) ?? []).filter(
                (m) => m.id !== row.id,
              );
              return {
                ...row,
                siblingCount: siblings.length,
                siblingIds: siblings.map((m) => m.id),
              };
            });
          return jsonResponse({
            credentials: collapsed,
            activeFingerprint: activeFp,
            ...sessionUsageField,
          });
        }

        return jsonResponse({
          credentials: enriched,
          activeFingerprint: activeFp,
          ...sessionUsageField,
        });
      }
      // Empty pool — fall through to filesystem reader.
      log.debug("pool.list() empty — falling back to filesystem reader");
    } catch (err) {
      log.warn({ error: err }, "pool.list() failed — falling back to filesystem reader");
    }
  }

  // Filesystem-fallback path.
  try {
    const result = await readCredentials();
    return jsonResponse({ ...result, ...sessionUsageField });
  } catch (err) {
    log.warn({ error: err }, "filesystem credential reader failed");
    return jsonResponse({
      credentials: [],
      activeFingerprint: null,
      ...sessionUsageField,
    });
  }
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
    claimed_actor: actor,
    claimed_ip: ip,
    timestamp_iso: new Date().toISOString(),
    detail: promoteId ? { promoted_to: promoteId } : undefined,
  });

  return new Response(null, { status: 204 });
}
