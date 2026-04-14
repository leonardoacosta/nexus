/**
 * Integration test for the credential fingerprint backfill migration.
 *
 * Requires a live PostgreSQL connection (POSTGRES_URL).
 * Seeds synthetic duplicate credentials and verifies that the backfill
 * correctly groups them, computes fingerprints, and assigns primaries.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import type { Db } from "@nexus/db";
import { backfillCredentialFingerprints } from "../../../../packages/db/src/migrations/backfill-credential-fingerprints";
import { encrypt, decrypt } from "./encryption";
import { hasPg, TEST_KEY, testId, deleteById, createTestDb } from "./credentials.helpers";

// ─── [8.6] Migration backfill collapses duplicates (requires live PG) ───────

describe.skipIf(!hasPg)("credential backfill — migration collapses duplicates (requires live PG)", () => {
  let db: Db;
  const ids: string[] = [];

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  it("[8.6] backfill groups 3 credentials with same refreshToken, newest becomes primary", async () => {
    const sharedRefreshToken = `sk-ant-ort01-backfill-${Date.now()}-${Math.random()}`;
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test",
        refreshToken: sharedRefreshToken,
        expiresAt: 1775033611232,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });

    const now = Date.now();
    const id1 = testId("bf-oldest");
    const id2 = testId("bf-middle");
    const id3 = testId("bf-newest");
    ids.push(id1, id2, id3);

    // Seed 3 rows with the same encrypted payload but different updatedAt.
    // Use raw db.insert() to bypass pool.add() fingerprint logic.
    const encrypted = encrypt(payload, TEST_KEY);

    await db.insert(credentials).values({
      id: id1,
      name: `bf-oldest-${id1}`,
      type: "anthropic",
      valueEncrypted: encrypted,
      encryptionKeyId: "v1",
      status: "available",
      rateLimitCount: 0,
      // Deliberately set fingerprint to placeholder — backfill will overwrite
      fingerprint: "placeholder-pre-backfill",
      duplicateGroupId: "placeholder-pre-backfill",
      isPrimary: false,
      createdAt: new Date(now - 3000),
      updatedAt: new Date(now - 3000), // oldest
    });

    await db.insert(credentials).values({
      id: id2,
      name: `bf-middle-${id2}`,
      type: "anthropic",
      valueEncrypted: encrypted,
      encryptionKeyId: "v1",
      status: "available",
      rateLimitCount: 0,
      fingerprint: "placeholder-pre-backfill",
      duplicateGroupId: "placeholder-pre-backfill",
      isPrimary: false,
      createdAt: new Date(now - 2000),
      updatedAt: new Date(now - 2000), // middle
    });

    await db.insert(credentials).values({
      id: id3,
      name: `bf-newest-${id3}`,
      type: "anthropic",
      valueEncrypted: encrypted,
      encryptionKeyId: "v1",
      status: "available",
      rateLimitCount: 0,
      fingerprint: "placeholder-pre-backfill",
      duplicateGroupId: "placeholder-pre-backfill",
      isPrimary: false,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000), // newest
    });

    // Run the backfill
    const result = await backfillCredentialFingerprints(db, {
      decrypt,
      encryptionKey: TEST_KEY,
    });

    expect(result.processed).toBeGreaterThanOrEqual(3);
    expect(result.degraded).toBe(0);

    // Re-fetch all 3 rows
    const row1 = (await db.select().from(credentials).where(eq(credentials.id, id1)))[0]!;
    const row2 = (await db.select().from(credentials).where(eq(credentials.id, id2)))[0]!;
    const row3 = (await db.select().from(credentials).where(eq(credentials.id, id3)))[0]!;

    // All 3 share the same fingerprint (SHA-256 of sharedRefreshToken)
    expect(row1.fingerprint).toBe(row2.fingerprint);
    expect(row2.fingerprint).toBe(row3.fingerprint);
    expect(row1.fingerprint).not.toBe("placeholder-pre-backfill");
    expect(row1.fingerprint).toHaveLength(64); // SHA-256 hex

    // All 3 share the same duplicateGroupId
    expect(row1.duplicateGroupId).toBe(row2.duplicateGroupId);
    expect(row2.duplicateGroupId).toBe(row3.duplicateGroupId);

    // Only the newest-updatedAt row is primary
    expect(row1.isPrimary).toBe(false);
    expect(row2.isPrimary).toBe(false);
    expect(row3.isPrimary).toBe(true); // newest
  });
});
