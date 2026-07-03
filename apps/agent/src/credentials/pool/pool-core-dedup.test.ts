/**
 * Live-PG integration test for credential re-import dedup (plan 008).
 *
 * Root cause covered: `CredentialPool.add()` used to unconditionally INSERT a
 * fresh row for every credential file it processed. The watcher calls add() on
 * every agent restart and every live file change; an OAuth token auto-refresh
 * rewrites acct-*.json in place (access token changes, refresh token — hence the
 * SHA-256 fingerprint — is stable). Without dedup this appended a new row per
 * refresh/restart, and the "newest mtime wins" promotion made each clone the
 * leaseable primary, silently dropping the prior row's lease/cooldown state.
 *
 * After the fix: a re-import of the SAME file (same fingerprint AND same name)
 * updates the existing row in place (preserving status / leasedBy /
 * cooldownUntil / rateLimitCount / isPrimary), while a genuinely distinct pool
 * file that shares a refresh token (same fingerprint, DIFFERENT name) still
 * inserts a duplicate-group member — the legitimate machinery is untouched.
 *
 * PG-gated on NEXUS_PG_TESTS=1 + POSTGRES_URL (skips cleanly otherwise). Uses an
 * isolated throwaway schema (createIsolatedSchema) so it never touches `public`.
 *
 * To run locally against a throwaway DB:
 *   createdb ... nexus_dedup_test
 *   NEXUS_ATTACH_SECRET=test NEXUS_PG_TESTS=1 \
 *     POSTGRES_URL=postgres://.../nexus_dedup_test \
 *     bun test apps/agent/src/credentials/pool/pool-core-dedup.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { credentials } from "@nexus/db";
import { CredentialPool } from "./pool-core";
import {
  TEST_KEY,
  computeCredentialFingerprint,
} from "../credentials.helpers";
import { hasLivePg as hasPg } from "../../testing/live-pg";
import {
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../testing/isolated-pg-schema";

// Minimal `credentials` DDL sufficient for the pool (mirrors
// packages/db/src/schema/credentials.ts; agent_id FK dropped for test isolation
// — the pool always writes agentId: null).
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

// Real Claude Code OAuth shape (fingerprint = SHA-256 of
// claudeAiOauth.refreshToken). FAKE tokens only — never real credentials.
const acct001 = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-plan008-0001",
    accessToken: "at-plan008-0001-v1",
    expiresAt: 1893456000000,
  },
});
const acct001Refreshed = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-plan008-0001", // SAME refresh token -> same fingerprint
    accessToken: "at-plan008-0001-v2", // rotated access token
    expiresAt: 1893456000000,
  },
});

describe.skipIf(!hasPg)("CredentialPool.add re-import dedup (plan 008)", () => {
  let iso: IsolatedSchema;
  let pool: CredentialPool;

  beforeAll(async () => {
    iso = await createIsolatedSchema(CREDENTIALS_DDL, "cred_dedup");
    pool = new CredentialPool(iso.db, { encryptionKey: TEST_KEY });
  });

  afterAll(async () => {
    await iso.drop();
  });

  it("re-import of the same (fingerprint, name) yields ONE row, not two", async () => {
    const name = `acct-001-${randomUUID().slice(0, 8)}`;

    const first = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: acct001,
    });
    const second = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: acct001, // identical file re-imported
    });

    expect(first).toBe("inserted");
    expect(second).toBe("updated");

    const rows = await iso.db
      .select()
      .from(credentials)
      .where(eq(credentials.name, name));
    expect(rows).toHaveLength(1);
  });

  it("refresh updates in place and preserves lease/cooldown state", async () => {
    const name = `acct-001-${randomUUID().slice(0, 8)}`;

    const inserted = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: acct001,
    });
    expect(inserted).toBe("inserted");

    const before = (
      await iso.db.select().from(credentials).where(eq(credentials.name, name))
    )[0]!;

    // Simulate an in-flight rate-limited credential: cooldown + lease state.
    const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000);
    await iso.db
      .update(credentials)
      .set({
        status: "cooldown",
        cooldownUntil,
        rateLimitCount: 3,
        leasedBy: "sess-x",
      })
      .where(eq(credentials.id, before.id));

    // Token auto-refresh rewrites the file (rotated access token).
    const outcome = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: acct001Refreshed,
    });
    expect(outcome).toBe("updated");

    const rows = await iso.db
      .select()
      .from(credentials)
      .where(eq(credentials.name, name));

    // Still exactly one row, lifecycle state preserved, token material changed.
    expect(rows).toHaveLength(1);
    const after = rows[0]!;
    expect(after.id).toBe(before.id); // same row, updated in place
    expect(after.status).toBe("cooldown");
    expect(after.cooldownUntil?.getTime()).toBe(cooldownUntil.getTime());
    expect(after.rateLimitCount).toBe(3);
    expect(after.leasedBy).toBe("sess-x");
    expect(after.isPrimary).toBe(before.isPrimary);
    // The rotated access token was written — NOT reset to an available clone.
    expect(after.valueEncrypted).not.toBe(before.valueEncrypted);
  });

  it("distinct file, same token still inserts a group member (machinery preserved)", async () => {
    const suffix = randomUUID().slice(0, 8);
    // Fresh refresh token so this group is isolated from the other tests.
    const rt = `rt-plan008-group-${suffix}`;
    const fileA = JSON.stringify({
      claudeAiOauth: {
        refreshToken: rt,
        accessToken: "at-A-v1",
        expiresAt: 1893456000000,
      },
    });
    const fileB = JSON.stringify({
      claudeAiOauth: {
        refreshToken: rt, // same token, DIFFERENT name
        accessToken: "at-A-v1",
        expiresAt: 1893456000000,
      },
    });
    const nameA = `acct-A-${suffix}`;
    const nameB = `acct-B-${suffix}`;

    const a = await pool.add({
      id: randomUUID(),
      name: nameA,
      type: "oauth",
      value_plaintext: fileA,
    });
    const b = await pool.add({
      id: randomUUID(),
      name: nameB,
      type: "oauth",
      value_plaintext: fileB,
    });

    expect(a).toBe("inserted");
    expect(b).toBe("inserted"); // distinct file -> new group member, NOT dedup

    const group = await iso.db
      .select()
      .from(credentials)
      .where(eq(credentials.duplicateGroupId, computeCredentialFingerprint(fileA)));

    expect(group).toHaveLength(2);
    expect(group.filter((r) => r.isPrimary)).toHaveLength(1);
    const groupIds = new Set(group.map((r) => r.duplicateGroupId));
    expect(groupIds.size).toBe(1); // both share one duplicate_group_id
  });
});
