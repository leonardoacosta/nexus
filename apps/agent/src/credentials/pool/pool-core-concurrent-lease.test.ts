/**
 * Live-PG regression test for nx-jz5f (credentials pool: recoverExpiredCooldowns()
 * called outside lease() transaction).
 *
 * Root cause: `recoverExpiredCooldowns()` used to run as a standalone UPDATE
 * BEFORE `lease()` opened its `db.transaction()`. That opened a race: the
 * recovery UPDATE could flip a cooldown row to `available`, and two concurrent
 * `lease()` calls could then both SELECT FOR UPDATE it before either commit —
 * double-leasing the same recovered credential to two different callers.
 *
 * Fix (see pool-core.ts `lease()`, lines ~386-423): the cooldown-recovery
 * UPDATE now runs INSIDE the same `db.transaction()` as the SELECT FOR UPDATE
 * lease-selection, so recovery and lease are one atomic unit — Postgres row
 * locking serializes concurrent callers instead of racing.
 *
 * This test proves the fix holds: with exactly ONE expired-cooldown credential
 * in the pool, firing two `lease()` calls concurrently must yield exactly one
 * non-null winner and one null (pool-exhausted) loser — never both non-null
 * for the same row.
 *
 * PG-gated on NEXUS_PG_TESTS=1 + POSTGRES_URL (skips cleanly otherwise). Uses an
 * isolated throwaway schema (createIsolatedSchema) so it never touches `public`.
 *
 * To run locally against a throwaway DB:
 *   NEXUS_ATTACH_SECRET=test NEXUS_PG_TESTS=1 \
 *     POSTGRES_URL=postgres://.../nexus_test \
 *     bun test apps/agent/src/credentials/pool/pool-core-concurrent-lease.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { credentials } from "@nexus/db";
import { CredentialPool } from "./pool-core";
import { TEST_KEY } from "../credentials.helpers";
import { encrypt } from "../encryption";
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

describe.skipIf(!hasPg)(
  "CredentialPool.lease() concurrent cooldown recovery (nx-jz5f regression)",
  () => {
    let iso: IsolatedSchema;
    let pool: CredentialPool;

    beforeAll(async () => {
      iso = await createIsolatedSchema(CREDENTIALS_DDL, "cred_lease_race");
      pool = new CredentialPool(iso.db, { encryptionKey: TEST_KEY });
    });

    afterAll(async () => {
      await iso.drop();
    });

    it("two concurrent lease() calls never double-lease the same recovered cooldown row", async () => {
      const id = randomUUID();
      const type = `oauth-${randomUUID().slice(0, 8)}`;

      // Seed exactly one credential sitting in an EXPIRED cooldown — the
      // window recoverExpiredCooldowns() is meant to reclaim.
      await iso.db.insert(credentials).values({
        id,
        name: `race-acct-${id.slice(0, 8)}`,
        type,
        valueEncrypted: encrypt("secret-value", TEST_KEY),
        status: "cooldown",
        cooldownUntil: new Date(Date.now() - 1000), // already expired
        rateLimitCount: 0,
        isPrimary: true,
      });

      // Fire two lease() calls concurrently for the same type. If recovery
      // ran outside the transaction (the pre-fix behaviour), both could
      // observe the row as available and both SELECT FOR UPDATE it.
      const [a, b] = await Promise.all([
        pool.lease(type, "caller-A"),
        pool.lease(type, "caller-B"),
      ]);

      const winners = [a, b].filter((r) => r !== null);
      const losers = [a, b].filter((r) => r === null);

      // Exactly one caller wins the single available credential; the other
      // finds the pool exhausted. Both non-null would mean double-lease.
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0]!.id).toBe(id);

      // Final DB state reflects exactly one leaseholder, not a corrupted
      // interleaving of both callers' writes.
      const rows = await iso.db
        .select()
        .from(credentials)
        .where(eq(credentials.id, id));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("leased");
      expect(
        row.leasedBy === "caller-A" || row.leasedBy === "caller-B",
      ).toBe(true);
      const winnerLeasedBy =
        winners[0]!.id === id ? winners[0]!.leasedBy : null;
      expect(winnerLeasedBy).toBe(row.leasedBy);
    });
  },
);
