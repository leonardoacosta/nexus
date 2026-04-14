/**
 * Backfill step for the `credential-identity` change (migration 0011).
 *
 * Reads every row from `credentials`, decrypts `value_encrypted`, parses the
 * OAuth JSON to extract `claudeAiOauth.refreshToken`, and writes:
 *   - `fingerprint`       = SHA-256 hex of the refresh token
 *   - `duplicate_group_id` = same as fingerprint
 *
 * After all rows are processed, the row in each duplicate group with the
 * newest `updated_at` is marked `is_primary = true`. Tiebreak on equal
 * `updated_at` is alphabetical by `name`.
 *
 * Degraded rows (decryption error, unparseable JSON, missing refreshToken)
 * are retained with `fingerprint = 'UNKNOWN-' || id`, `duplicate_group_id`
 * equal to that fingerprint, and `is_primary = true` so they remain visible
 * in `GET /credentials` as degenerate 1-member groups. A warning is logged
 * via the injected `logger` callback.
 *
 * The backfill is idempotent: re-running it produces the same final state.
 *
 * ## Dependency injection
 *
 * To keep `@nexus/db` independent of `apps/agent` internals, this function
 * receives the `decrypt` helper and the 32-byte encryption key as parameters.
 * Callers (the agent's migrate step) wire in `decrypt` from
 * `apps/agent/src/credentials/encryption.ts` and the key from
 * `loadEncryptionKey()`. An optional `logger` callback is used for WARN
 * entries on degraded rows; by default it falls through to `console.warn`.
 */

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../client";
import { credentials } from "../schema/credentials";

/** Signature of the injected decrypt helper (from the agent's encryption module). */
export type DecryptFn = (ciphertext: string, key: Buffer) => string;

/** Minimal structural logger interface. */
export interface BackfillLogger {
  warn(payload: { credentialId: string; error: string }): void;
}

export interface BackfillOptions {
  /** Decrypt function — typically `decrypt` from apps/agent/src/credentials/encryption.ts. */
  decrypt: DecryptFn;
  /** 32-byte AES-256-GCM key from `loadEncryptionKey()`. */
  encryptionKey: Buffer;
  /** Optional logger; defaults to `console.warn`. */
  logger?: BackfillLogger;
}

export interface BackfillResult {
  /** Total rows scanned. */
  processed: number;
  /** Number of distinct duplicate groups that ended with a primary assignment. */
  grouped: number;
  /** Number of rows that fell back to `UNKNOWN-<id>` because decrypt/parse failed. */
  degraded: number;
}

const defaultLogger: BackfillLogger = {
  warn: ({ credentialId, error }) => {
    console.warn(
      `[backfill-credential-fingerprints] degraded row credentialId=${credentialId} error=${error}`,
    );
  },
};

/**
 * Compute the lowercase-hex SHA-256 of a refresh token.
 * Exported for reuse by the fingerprint helper in apps/agent.
 */
export function sha256Hex(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

/**
 * Extract the refresh token from a decrypted credential plaintext blob.
 * Throws if the JSON cannot be parsed or the expected shape is missing.
 */
function extractRefreshToken(plaintext: string): string {
  const parsed: unknown = JSON.parse(plaintext);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("plaintext is not a JSON object");
  }
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    throw new Error("missing claudeAiOauth object");
  }
  const token = (oauth as { refreshToken?: unknown }).refreshToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("missing claudeAiOauth.refreshToken");
  }
  return token;
}

/**
 * Run the backfill against the given Drizzle db handle.
 *
 * Idempotency: the function always recomputes fingerprints from plaintext,
 * so running it twice produces the same final state. Primary flags are
 * reset to `false` at the start of each run and re-derived from the fresh
 * (fingerprint, updatedAt, name) tuple.
 */
export async function backfillCredentialFingerprints(
  db: Db,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const logger = options.logger ?? defaultLogger;
  const { decrypt, encryptionKey } = options;

  const rows = await db.select().from(credentials);

  const result: BackfillResult = {
    processed: rows.length,
    grouped: 0,
    degraded: 0,
  };

  // Phase 1 — compute (fingerprint, duplicateGroupId) for every row and
  // reset isPrimary to false so the subsequent primary-selection phase
  // starts from a known clean state. Track degraded rows separately —
  // those are their own 1-member groups and are force-primary.
  interface ComputedRow {
    id: string;
    name: string;
    fingerprint: string;
    updatedAt: Date;
    degraded: boolean;
  }
  const computed: ComputedRow[] = [];

  for (const row of rows) {
    let fingerprint: string;
    let degraded = false;

    try {
      if (!row.valueEncrypted) {
        throw new Error("value_encrypted is null");
      }
      const plaintext = decrypt(row.valueEncrypted, encryptionKey);
      const refreshToken = extractRefreshToken(plaintext);
      fingerprint = sha256Hex(refreshToken);
    } catch (err) {
      degraded = true;
      fingerprint = `UNKNOWN-${row.id}`;
      logger.warn({
        credentialId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.degraded += 1;
    }

    await db
      .update(credentials)
      .set({
        fingerprint,
        duplicateGroupId: fingerprint,
        isPrimary: false,
      })
      .where(eq(credentials.id, row.id));

    computed.push({
      id: row.id,
      name: row.name,
      fingerprint,
      updatedAt: row.updatedAt,
      degraded,
    });
  }

  // Phase 2 — group by fingerprint and pick exactly one primary per group.
  // Newest updatedAt wins; tiebreak alphabetical by name. Degraded rows are
  // always their own group of 1 (their fingerprint is UNKNOWN-<id>), so
  // they fall through this same logic and become primary naturally.
  const groups = new Map<string, ComputedRow[]>();
  for (const entry of computed) {
    const bucket = groups.get(entry.fingerprint) ?? [];
    bucket.push(entry);
    groups.set(entry.fingerprint, bucket);
  }

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      // Newest updatedAt first.
      const diff = b.updatedAt.getTime() - a.updatedAt.getTime();
      if (diff !== 0) return diff;
      // Tiebreak alphabetical by name.
      return a.name.localeCompare(b.name);
    });
    const primary = bucket[0];
    if (!primary) continue;
    await db
      .update(credentials)
      .set({ isPrimary: true })
      .where(eq(credentials.id, primary.id));
    result.grouped += 1;
  }

  return result;
}
