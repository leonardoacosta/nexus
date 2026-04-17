/**
 * Credential Attribution
 *
 * Resolves which credential was active for a given turn timestamp within
 * a session. Used at turn-insert time to denormalize credential identity
 * onto each token turn row.
 *
 * NOTE: The `credential_swaps` table does not exist in the current DB schema
 * (it may be Rust-only or not yet migrated). Attribution currently falls back
 * to `sessions.credential_id` / `sessions.credential_fingerprint` for every
 * turn. When `credential_swaps` is added, the swap-lookup branch should be
 * implemented here.
 */

import type { Db } from "@nexus/db";
import { sessions, credentials, eq } from "@nexus/db";
import { createLogger } from "@nexus/core";

const log = createLogger("agent:token-stream:attribution");

export interface AttributionResult {
  credentialId: string | null;
  credentialFingerprint: string | null;
}

/**
 * Attribute a turn to the credential that was active at the given timestamp.
 *
 * Current implementation: returns the session's initial credential assignment.
 * Future: query `credential_swaps` for intra-session rotations.
 *
 * @param db        - Database connection
 * @param sessionId - The nexus session ID
 * @param _turnTs   - Turn timestamp (unused until credential_swaps table exists)
 * @returns The credential ID and fingerprint, or nulls if not attributable.
 */
export async function attributeTurnToCredential(
  db: Db,
  sessionId: string,
  _turnTs: Date,
): Promise<AttributionResult> {
  // Future work: see bead nx-wce7 (Add credential_swaps table) for per-turn
  // credential attribution. Current fallback uses session-level credential.

  // Fallback: use the session's initial credential assignment
  const sessionRows = await db
    .select({
      credentialId: sessions.credentialId,
      credentialFingerprint: sessions.credentialFingerprint,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const session = sessionRows[0];
  if (!session) {
    log.warn({ sessionId }, "session not found for attribution");
    return { credentialId: null, credentialFingerprint: null };
  }

  // If we have a credential ID but no fingerprint, attempt to look it up
  if (session.credentialId && !session.credentialFingerprint) {
    const credRows = await db
      .select({ fingerprint: credentials.fingerprint })
      .from(credentials)
      .where(eq(credentials.id, session.credentialId))
      .limit(1);

    const fingerprint = credRows[0]?.fingerprint ?? null;
    return {
      credentialId: session.credentialId,
      credentialFingerprint: fingerprint,
    };
  }

  return {
    credentialId: session.credentialId,
    credentialFingerprint: session.credentialFingerprint,
  };
}
