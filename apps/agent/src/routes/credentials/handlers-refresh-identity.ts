/**
 * Identity re-probe handlers.
 *
 * - POST /credentials/:id/refresh-identity
 *   Manually re-probe a single credential's /api/oauth/profile.
 *   Returns the new identity object, or `{ error }` on failure.
 *
 * - POST /credentials/refresh-identity-all
 *   Re-probe every credential whose `account_email IS NULL`. Returns
 *   `{ probed, succeeded, failed }`.
 *
 * Idempotent — safe to call repeatedly. Used by the dashboard's
 * "refresh" button on rows that came up anonymous (typically because the
 * original `add()`-time probe failed transiently).
 */

import { credentials } from "@nexus/db";
import { eq, isNull } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { dbRef, poolRef, jsonResponse } from "./shared";

const log = createLogger("agent:routes:credentials:refresh-identity");

interface IdentityFields {
  accountEmail: string | null;
  accountName: string | null;
  accountUuid: string | null;
  orgName: string | null;
  orgUuid: string | null;
}

async function readIdentity(
  db: NonNullable<typeof dbRef.current>,
  id: string,
): Promise<IdentityFields | null> {
  const rows = await db
    .select({
      accountEmail: credentials.accountEmail,
      accountName: credentials.accountName,
      accountUuid: credentials.accountUuid,
      orgName: credentials.orgName,
      orgUuid: credentials.orgUuid,
    })
    .from(credentials)
    .where(eq(credentials.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** POST /credentials/:id/refresh-identity */
export async function handleRefreshIdentity(id: string): Promise<Response> {
  const pool = poolRef.current;
  const db = dbRef.current;
  if (!pool || !db) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  // Look up the row to confirm it exists, then decrypt + probe.
  const before = await readIdentity(db, id);
  if (!before) {
    return jsonResponse({ error: "credential not found" }, 404);
  }

  let plaintext: string | null = null;
  try {
    plaintext = await pool.getDecrypted(id);
  } catch (err) {
    log.warn(
      { id, err: err instanceof Error ? err.message : String(err) },
      "refresh-identity: decrypt failed",
    );
    return jsonResponse(
      { error: "failed to decrypt credential", code: "DECRYPT_FAILED" },
      500,
    );
  }
  if (!plaintext) {
    return jsonResponse(
      { error: "credential has no encrypted value", code: "NO_PLAINTEXT" },
      500,
    );
  }

  try {
    await pool.probeIdentity(id, plaintext);
  } catch (err) {
    log.warn(
      { id, err: err instanceof Error ? err.message : String(err) },
      "refresh-identity: probe threw",
    );
    return jsonResponse(
      {
        error:
          err instanceof Error ? err.message : "upstream profile probe failed",
        code: "UPSTREAM_FAILED",
      },
      502,
    );
  }

  const after = await readIdentity(db, id);
  if (!after) {
    // Row was deleted between probe + read — treat as 404.
    return jsonResponse({ error: "credential not found after probe" }, 404);
  }

  // Surface a 502 when probeIdentity ran but identity remained blank — the
  // upstream API returned a non-2xx or empty body. probeIdentity itself
  // never throws on non-2xx, it just logs.
  if (
    !after.accountEmail &&
    !after.accountName &&
    !after.accountUuid &&
    !after.orgName &&
    !after.orgUuid
  ) {
    return jsonResponse(
      {
        error: "identity probe returned no fields",
        code: "UPSTREAM_BLANK",
      },
      502,
    );
  }

  return jsonResponse(after, 200);
}

/** POST /credentials/refresh-identity-all */
export async function handleRefreshIdentityAll(): Promise<Response> {
  const pool = poolRef.current;
  const db = dbRef.current;
  if (!pool || !db) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(isNull(credentials.accountEmail));

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    let plaintext: string | null = null;
    try {
      plaintext = await pool.getDecrypted(row.id);
    } catch {
      failed++;
      continue;
    }
    if (!plaintext) {
      failed++;
      continue;
    }
    try {
      await pool.probeIdentity(row.id, plaintext);
      // Re-read to determine whether the probe actually populated a field.
      const updated = await readIdentity(db, row.id);
      if (
        updated &&
        (updated.accountEmail ||
          updated.accountName ||
          updated.accountUuid ||
          updated.orgName ||
          updated.orgUuid)
      ) {
        succeeded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return jsonResponse(
    { probed: rows.length, succeeded, failed },
    200,
  );
}
