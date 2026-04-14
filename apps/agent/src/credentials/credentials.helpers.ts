/**
 * Credential helpers — fingerprinting + shared test fixtures.
 *
 * Two responsibilities live in this module:
 *
 * 1. Runtime fingerprint helpers used by the credential pool:
 *    - `computeCredentialFingerprint(plaintext)` — SHA-256 of
 *      `claudeAiOauth.refreshToken`
 *    - `CredentialParseError` — thrown when the OAuth blob cannot be parsed
 *
 * 2. Shared fixture helpers consumed by the credential test suite (split
 *    across credential-*.test.ts files). The fixture helpers (`makeRow`,
 *    `makeQueryChain`, `testId`, `deleteById`, `createTestDb`, `TEST_KEY`)
 *    are exported here so that the .test.ts files do not need to maintain
 *    parallel copies.
 *
 * Keeping both in a non-`.test.ts` file means the runtime helpers are part
 * of the production surface and are typechecked even when test discovery is
 * skipped.
 */

import { createHash } from "node:crypto";

import type { CredentialRow } from "./store";
import type { Buffer as NodeBuffer } from "node:buffer";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import { encrypt } from "./encryption";
import { openDatabase } from "../db/database";

// ─── Fingerprint helpers ─────────────────────────────────────────────────────

/**
 * Discriminator for credential parse failures so HTTP handlers can translate
 * the error into a 400 response without instanceof guards on subclassing
 * across test boundaries.
 */
export class CredentialParseError extends Error {
  readonly code = "CREDENTIAL_PARSE_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "CredentialParseError";
  }
}

/**
 * Compute a stable, opaque identity key for an OAuth credential blob.
 *
 * Parses the plaintext as JSON, extracts `claudeAiOauth.refreshToken`, and
 * returns the lowercase-hex SHA-256 of that token. The refresh token is
 * stable across access-token refreshes and unique per Anthropic account, so
 * the resulting hash is a deterministic identity that does not depend on
 * filenames, ids, or ciphertext bytes.
 *
 * Mirrors the migration backfill helper `sha256Hex` in
 * `packages/db/src/migrations/backfill-credential-fingerprints.ts`. The
 * one-line SHA-256 is duplicated rather than imported to avoid a runtime
 * dependency on the migration module from the agent's hot path.
 *
 * @throws {CredentialParseError} when the plaintext is not JSON, is missing
 *   `claudeAiOauth`, or is missing a non-empty string `refreshToken`.
 */
export function computeCredentialFingerprint(plaintext: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new CredentialParseError(
      `credential plaintext is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new CredentialParseError("credential plaintext is not a JSON object");
  }

  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    throw new CredentialParseError(
      "credential is missing the claudeAiOauth object",
    );
  }

  const refreshToken = (oauth as { refreshToken?: unknown }).refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new CredentialParseError(
      "credential is missing claudeAiOauth.refreshToken",
    );
  }

  return createHash("sha256").update(refreshToken).digest("hex");
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const hasPg = !!process.env.POSTGRES_URL;

/** Test encryption key: 32 bytes, non-zero (non-zero to avoid all-zero key pitfalls) */
export const TEST_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
export const TEST_KEY: NodeBuffer = Buffer.from(TEST_KEY_HEX, "hex") as NodeBuffer;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a unique test credential ID so parallel runs don't collide. */
export function testId(base: string): string {
  return `test-cred-${base}-${Date.now()}`;
}

/** Delete credentials by id (cleanup helper). */
export async function deleteById(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.delete(credentials).where(eq(credentials.id, id));
  }
}

/** Build a standard test credential row with optional overrides. */
export function makeRow(id: string, overrides: Partial<CredentialRow> = {}): CredentialRow {
  const now = new Date();
  // Per credential-identity spec: every row carries a non-null fingerprint and
  // is its own 1-member duplicate group by default. Tests that exercise
  // grouping pass `fingerprint`/`duplicateGroupId`/`isPrimary` overrides.
  const fingerprint = `test-fp-${id}`;
  return {
    id,
    name: `store-test-${id}`,
    type: "anthropic",
    valueEncrypted: encrypt("secret-value", TEST_KEY),
    encryptionKeyId: "v1",
    agentId: null,
    status: "available",
    leasedBy: null,
    leasedAt: null,
    cooldownUntil: null,
    rateLimitCount: 0,
    fingerprint,
    duplicateGroupId: fingerprint,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Build a query builder stub that returns `rows` when awaited at any point
 * in the chain (select / from / where / orderBy / for / limit / etc.).
 * This satisfies both the outer queries (recoverExpiredCooldowns, queryStaleLeases)
 * and the inner transaction queries.
 */
export function makeQueryChain(rows: CredentialRow[]): unknown {
  const p = Promise.resolve(rows);
  const chain: Record<string, unknown> & PromiseLike<CredentialRow[]> = {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
  for (const method of [
    "select", "from", "where", "for", "orderBy", "limit",
    "and", "lte", "eq",
  ]) {
    chain[method] = (..._args: unknown[]) => chain;
  }
  return chain;
}

/** Create a test database connection (requires POSTGRES_URL). */
export function createTestDb(): Db {
  return openDatabase();
}
