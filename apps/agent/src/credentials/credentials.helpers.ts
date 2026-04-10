/**
 * Shared test helpers for credential system tests.
 *
 * Extracted from credentials.test.ts to support split test files.
 */

import type { CredentialRow } from "./store";
import type { Buffer as NodeBuffer } from "node:buffer";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import { encrypt } from "./encryption";
import { openDatabase } from "../db/database";

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
