/**
 * Live-PG integration test for `CredentialPool.updateSecret()`.
 *
 * Spec: fix-credential-usage-poller-100pct-failure (task 3)
 *
 * `updateSecret()` exists because `add()` cannot be reused for a real OAuth
 * refresh: a refresh grant rotates the refresh token, so `add()`'s
 * `(fingerprint, name)` re-import match would miss on the OLD fingerprint
 * and INSERT a duplicate row instead of updating the credential that was
 * just refreshed. This suite proves:
 *   - the fingerprint column is recomputed from the NEW refresh token
 *   - `duplicateGroupId` survives the rotation unchanged (stable account
 *     anchor per the schema comment)
 *   - lease/status/isPrimary state is untouched (same contract as `add()`'s
 *     update-in-place path)
 *   - the encrypted value round-trips to the new plaintext
 *
 * PG-gated on NEXUS_PG_TESTS=1 + POSTGRES_URL (skips cleanly otherwise). Uses
 * an isolated throwaway schema (createIsolatedSchema), same DDL shape as
 * pool-core-dedup.test.ts.
 *
 * To run locally against a throwaway DB:
 *   createdb ... nexus_update_secret_test
 *   NEXUS_ATTACH_SECRET=test NEXUS_PG_TESTS=1 \
 *     POSTGRES_URL=postgres://.../nexus_update_secret_test \
 *     bun test apps/agent/src/credentials/pool/pool-core-update-secret.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { credentials } from "@nexus/db";
import { CredentialPool } from "./pool-core";
import { TEST_KEY, computeCredentialFingerprint } from "../credentials.helpers";
import { decrypt } from "../encryption";
import { hasLivePg as hasPg } from "../../testing/live-pg";
import { createIsolatedSchema, type IsolatedSchema } from "../../testing/isolated-pg-schema";

const CREDENTIALS_DDL = `
CREATE TABLE credentials (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  value_encrypted text,
  encryption_key_id text DEFAULT 'v1',
  agent_id text,
  status text NOT NULL DEFAULT 'available',
  leased_by text,
  leased_at timestamp,
  cooldown_until timestamp,
  rate_limit_count integer NOT NULL DEFAULT 0,
  fingerprint text NOT NULL DEFAULT '',
  duplicate_group_id text,
  is_primary boolean NOT NULL DEFAULT false,
  subscription_type text,
  rate_limit_tier text,
  expires_at timestamptz,
  account_email text,
  account_name text,
  account_uuid text,
  org_name text,
  org_uuid text,
  mcp_providers text,
  usage_5h_used integer,
  usage_5h_limit integer,
  usage_5h_reset_at timestamptz,
  usage_7d_used integer,
  usage_7d_limit integer,
  usage_7d_reset_at timestamptz,
  usage_polled_at timestamptz,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX credentials_fingerprint_idx ON credentials (fingerprint);
CREATE INDEX credentials_group_primary_idx ON credentials (duplicate_group_id, is_primary);
`;

describe.skipIf(!hasPg)("CredentialPool.updateSecret (fix-credential-usage-poller-100pct-failure)", () => {
  let iso: IsolatedSchema;
  let pool: CredentialPool;

  beforeAll(async () => {
    iso = await createIsolatedSchema(CREDENTIALS_DDL, "cred_update_secret");
    pool = new CredentialPool(iso.db, { encryptionKey: TEST_KEY });
  });

  afterAll(async () => {
    await iso.drop();
  });

  it("rotates the fingerprint, preserves duplicateGroupId + lease state, and re-encrypts the new blob", async () => {
    const suffix = randomUUID().slice(0, 8);
    const oldRefreshToken = `rt-update-secret-old-${suffix}`;
    const oldBlob = JSON.stringify({
      claudeAiOauth: {
        refreshToken: oldRefreshToken,
        accessToken: "at-old",
        expiresAt: 1893456000000,
      },
    });
    const name = `acct-update-secret-${suffix}`;

    const inserted = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: oldBlob,
    });
    expect(inserted).toBe("inserted");

    const before = (
      await iso.db.select().from(credentials).where(eq(credentials.name, name))
    )[0]!;
    const originalGroupId = before.duplicateGroupId;
    expect(originalGroupId).toBe(computeCredentialFingerprint(oldBlob));

    // Simulate a row mid-lifecycle: leased, with rate-limit history.
    await iso.db
      .update(credentials)
      .set({ status: "leased", leasedBy: "sess-refresh-test", rateLimitCount: 2 })
      .where(eq(credentials.id, before.id));

    // A real refresh grant rotates BOTH tokens.
    const newRefreshToken = `rt-update-secret-new-${suffix}`;
    const newExpiresAt = new Date(Date.now() + 3600 * 1000);
    const newBlob = {
      claudeAiOauth: {
        refreshToken: newRefreshToken,
        accessToken: "at-new",
        expiresAt: newExpiresAt.getTime(),
      },
    };

    await pool.updateSecret(before.id, newBlob, newExpiresAt);

    const after = (
      await iso.db.select().from(credentials).where(eq(credentials.id, before.id))
    )[0]!;

    // Fingerprint rotated to match the NEW refresh token.
    expect(after.fingerprint).toBe(computeCredentialFingerprint(JSON.stringify(newBlob)));
    expect(after.fingerprint).not.toBe(before.fingerprint);

    // duplicateGroupId is the stable account anchor — untouched by rotation.
    expect(after.duplicateGroupId).toBe(originalGroupId);

    // Lease/status state from `add()`'s update-in-place contract is preserved
    // here too — updateSecret() only ever touches token material + expiry.
    expect(after.status).toBe("leased");
    expect(after.leasedBy).toBe("sess-refresh-test");
    expect(after.rateLimitCount).toBe(2);
    expect(after.isPrimary).toBe(before.isPrimary);

    // expiresAt column updated to the new expiry.
    expect(after.expiresAt?.getTime()).toBe(newExpiresAt.getTime());

    // Ciphertext round-trips to the new plaintext.
    expect(after.valueEncrypted).not.toBe(before.valueEncrypted);
    const decrypted = decrypt(after.valueEncrypted!, TEST_KEY);
    expect(JSON.parse(decrypted)).toEqual(newBlob);
  });

  it("throws CredentialParseError when the new blob has no refreshToken", async () => {
    const suffix = randomUUID().slice(0, 8);
    const name = `acct-update-secret-badblob-${suffix}`;
    const inserted = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: JSON.stringify({
        claudeAiOauth: {
          refreshToken: `rt-update-secret-badblob-${suffix}`,
          accessToken: "at",
          expiresAt: 1893456000000,
        },
      }),
    });
    expect(inserted).toBe("inserted");
    const row = (
      await iso.db.select().from(credentials).where(eq(credentials.name, name))
    )[0]!;

    await expect(
      pool.updateSecret(row.id, { claudeAiOauth: { accessToken: "no-refresh-token" } }, new Date()),
    ).rejects.toThrow();
  });
});
