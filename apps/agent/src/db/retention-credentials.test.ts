/**
 * Live-PG integration test for `deleteStaleCredentials()` (nx-lp8v/nx-m5q6
 * GC half of the credentials-table-bloat fix).
 *
 * Context
 * -------
 * `active-credential-watcher.test.ts` and `pool-core-dedup.test.ts` /
 * `pool-core-update-secret.test.ts` cover the ROOT-CAUSE half of this fix
 * (the watcher now calls `pool.updateSecret()` in place on a fingerprint
 * rotation instead of unconditionally `pool.add()`-ing a new row, so future
 * rotations stop minting duplicates). This file covers the other half: the
 * one-time / ongoing GC that prunes the junk rows the bug already produced
 * (2,709 rows / 4.03MB payload with only 1 `isActive`, live-measured
 * 2026-07-11) down to the real distinct credentials, WITHOUT deleting the
 * live/primary row or any row that doesn't match the safe-delete predicate.
 *
 * `deleteStaleCredentials()` (apps/agent/src/db/retention.ts) is deliberately
 * conservative — see its doc comment for the full predicate rationale. This
 * suite proves, against a real Postgres instance (not a mock), that the
 * predicate:
 *   1. deletes a `status = 'refresh_failed'` orphan past the retention window
 *   2. deletes an `is_primary = false` duplicate-group member past the window
 *      REGARDLESS of its status (it can never be leased either way)
 *   3. NEVER deletes the real primary/active row (`is_primary = true`,
 *      `status = 'available'`), no matter how old — there is no query-time
 *      signal to distinguish "idle backup" from "abandoned orphan" for that
 *      combination, so the predicate intentionally excludes it
 *   4. NEVER deletes a row currently checked out (`leased_by IS NOT NULL`),
 *      even if it otherwise matches — the safety belt
 *   5. NEVER deletes a row updated inside the retention window, even if it
 *      otherwise matches — the freshness guard
 *   6. reduces a realistic fixture (1 real active account + many
 *      accumulated junk duplicates, mirroring the live nx-lp8v/nx-m5q6
 *      measurement) down to exactly the surviving set, in one pass
 *
 * PG-gated on NEXUS_PG_TESTS=1 + POSTGRES_URL (skips cleanly otherwise). Uses
 * an isolated throwaway schema (createIsolatedSchema), same DDL shape as
 * pool-core-dedup.test.ts / pool-core-update-secret.test.ts.
 *
 * To run locally:
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. NEXUS_ATTACH_SECRET=test NEXUS_PG_TESTS=1 \
 *        POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test \
 *        bun test apps/agent/src/db/retention-credentials.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { credentials } from "@nexus/db";
import { deleteStaleCredentials } from "./retention";
import { hasLivePg as hasPg } from "../testing/live-pg";
import {
  createIsolatedSchema,
  type IsolatedSchema,
} from "../testing/isolated-pg-schema";

// Minimal `credentials` DDL sufficient for the retention predicate (mirrors
// packages/db/src/schema/credentials.ts; same shape as pool-core-dedup.test.ts
// / pool-core-update-secret.test.ts for consistency across the credential
// test suite).
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
`;

const RETENTION_DAYS = 30;
const OLD = new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000); // past the window
const FRESH = new Date(Date.now() - 1 * 86_400_000); // inside the window
const CUTOFF = new Date(Date.now() - RETENTION_DAYS * 86_400_000);

interface Fixture {
  id: string;
  name: string;
  fingerprint: string;
  duplicateGroupId: string;
  status: string;
  isPrimary: boolean;
  leasedBy: string | null;
  updatedAt: Date;
}

async function seed(iso: IsolatedSchema, rows: Fixture[]): Promise<void> {
  for (const row of rows) {
    await iso.db.insert(credentials).values({
      id: row.id,
      name: row.name,
      type: "oauth",
      fingerprint: row.fingerprint,
      duplicateGroupId: row.duplicateGroupId,
      status: row.status,
      isPrimary: row.isPrimary,
      leasedBy: row.leasedBy,
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
    });
  }
}

async function remainingIds(iso: IsolatedSchema): Promise<Set<string>> {
  const rows = await iso.db.select({ id: credentials.id }).from(credentials);
  return new Set(rows.map((r) => r.id));
}

describe.skipIf(!hasPg)(
  "deleteStaleCredentials (nx-lp8v/nx-m5q6 credentials GC)",
  () => {
    let iso: IsolatedSchema;

    beforeAll(async () => {
      iso = await createIsolatedSchema(CREDENTIALS_DDL, "cred_retention");
    });

    afterAll(async () => {
      await iso.drop();
    });

    it("deletes a stale refresh_failed row past the retention window", async () => {
      const id = randomUUID();
      await seed(iso, [
        {
          id,
          name: "acct-refresh-failed",
          fingerprint: `fp-${id}`,
          duplicateGroupId: `fp-${id}`,
          status: "refresh_failed",
          isPrimary: true, // first-and-only in its own group, per retention.ts doc
          leasedBy: null,
          updatedAt: OLD,
        },
      ]);

      const count = await deleteStaleCredentials(iso.db, CUTOFF);
      expect(count).toBeGreaterThanOrEqual(1);

      const remaining = await remainingIds(iso);
      expect(remaining.has(id)).toBe(false);
    });

    it("deletes a stale is_primary=false duplicate-group member regardless of status", async () => {
      const id = randomUUID();
      const groupId = `fp-group-${id}`;
      await seed(iso, [
        {
          id,
          name: "acct-non-primary",
          fingerprint: groupId,
          duplicateGroupId: groupId,
          status: "available", // status doesn't matter for this predicate branch
          isPrimary: false,
          leasedBy: null,
          updatedAt: OLD,
        },
      ]);

      await deleteStaleCredentials(iso.db, CUTOFF);

      const remaining = await remainingIds(iso);
      expect(remaining.has(id)).toBe(false);
    });

    it("NEVER deletes the real primary/active row, no matter how old", async () => {
      const id = randomUUID();
      const groupId = `fp-active-${id}`;
      await seed(iso, [
        {
          id,
          name: "acct-real-active",
          fingerprint: groupId,
          duplicateGroupId: groupId,
          status: "available",
          isPrimary: true,
          leasedBy: null,
          // Deliberately ancient — the predicate excludes isPrimary=true +
          // available regardless of age (see retention.ts doc comment).
          updatedAt: new Date(Date.now() - 400 * 86_400_000),
        },
      ]);

      await deleteStaleCredentials(iso.db, CUTOFF);

      const remaining = await remainingIds(iso);
      expect(remaining.has(id)).toBe(true);
    });

    it("NEVER deletes a row currently leased out, even if otherwise stale + non-primary", async () => {
      const id = randomUUID();
      const groupId = `fp-leased-${id}`;
      await seed(iso, [
        {
          id,
          name: "acct-leased",
          fingerprint: groupId,
          duplicateGroupId: groupId,
          status: "leased",
          isPrimary: false,
          leasedBy: "session-abc",
          updatedAt: OLD,
        },
      ]);

      await deleteStaleCredentials(iso.db, CUTOFF);

      const remaining = await remainingIds(iso);
      expect(remaining.has(id)).toBe(true);
    });

    it("NEVER deletes a row updated inside the retention window, even if otherwise stale + non-primary", async () => {
      const id = randomUUID();
      const groupId = `fp-fresh-${id}`;
      await seed(iso, [
        {
          id,
          name: "acct-fresh-orphan",
          fingerprint: groupId,
          duplicateGroupId: groupId,
          status: "refresh_failed",
          isPrimary: false,
          leasedBy: null,
          updatedAt: FRESH,
        },
      ]);

      await deleteStaleCredentials(iso.db, CUTOFF);

      const remaining = await remainingIds(iso);
      expect(remaining.has(id)).toBe(true);
    });

    it("reduces a realistic accumulated-junk fixture down to exactly the real distinct credentials", async () => {
      // Mirrors the live nx-lp8v/nx-m5q6 shape: one real account whose row is
      // the primary/active credential, plus a pile of rotation-orphaned
      // duplicates left behind by the pre-fix add()-on-every-rotation bug —
      // some already flipped to refresh_failed by credential-refresh-job,
      // some just demoted non-primary group members. A second, distinct real
      // account (different duplicate_group_id) proves the sweep doesn't
      // cross account boundaries.
      const acctA = randomUUID();
      const acctAGroup = `fp-acctA-${acctA}`;
      const acctB = randomUUID();
      const acctBGroup = `fp-acctB-${acctB}`;

      const junkAIds = Array.from({ length: 12 }, () => randomUUID());
      const junkBIds = Array.from({ length: 5 }, () => randomUUID());

      const rows: Fixture[] = [
        // Real, currently-active credential for account A.
        {
          id: acctA,
          name: "acct-A-real",
          fingerprint: acctAGroup,
          duplicateGroupId: acctAGroup,
          status: "available",
          isPrimary: true,
          leasedBy: null,
          updatedAt: FRESH,
        },
        // Real, currently-active credential for account B.
        {
          id: acctB,
          name: "acct-B-real",
          fingerprint: acctBGroup,
          duplicateGroupId: acctBGroup,
          status: "available",
          isPrimary: true,
          leasedBy: null,
          updatedAt: FRESH,
        },
        // Account A junk: rotation orphans, demoted non-primary, old.
        ...junkAIds.map(
          (id, i): Fixture => ({
            id,
            name: `acct-A-orphan-${i}`,
            fingerprint: acctAGroup,
            duplicateGroupId: acctAGroup,
            status: i % 2 === 0 ? "refresh_failed" : "available",
            isPrimary: false,
            leasedBy: null,
            updatedAt: OLD,
          }),
        ),
        // Account B junk: same shape, smaller pile.
        ...junkBIds.map(
          (id, i): Fixture => ({
            id,
            name: `acct-B-orphan-${i}`,
            fingerprint: acctBGroup,
            duplicateGroupId: acctBGroup,
            status: "refresh_failed",
            isPrimary: false,
            leasedBy: null,
            updatedAt: OLD,
          }),
        ),
      ];

      await seed(iso, rows);

      const before = await remainingIds(iso);
      for (const r of rows) expect(before.has(r.id)).toBe(true); // sanity: all seeded

      const deletedCount = await deleteStaleCredentials(iso.db, CUTOFF);
      expect(deletedCount).toBe(junkAIds.length + junkBIds.length);

      const after = await remainingIds(iso);
      // The two real accounts survive.
      expect(after.has(acctA)).toBe(true);
      expect(after.has(acctB)).toBe(true);
      // Every junk row is gone.
      for (const id of [...junkAIds, ...junkBIds]) {
        expect(after.has(id)).toBe(false);
      }
      // Exactly the real set remains among the rows this test seeded.
      const seededIds = new Set(rows.map((r) => r.id));
      const remainingFromThisTest = [...after].filter((id) => seededIds.has(id));
      expect(remainingFromThisTest.sort()).toEqual([acctA, acctB].sort());
    });

    it("is idempotent: a second run with the same cutoff deletes nothing further", async () => {
      const id = randomUUID();
      const groupId = `fp-idempotent-${id}`;
      await seed(iso, [
        {
          id,
          name: "acct-idempotent-junk",
          fingerprint: groupId,
          duplicateGroupId: groupId,
          status: "refresh_failed",
          isPrimary: true,
          leasedBy: null,
          updatedAt: OLD,
        },
      ]);

      const first = await deleteStaleCredentials(iso.db, CUTOFF);
      expect(first).toBeGreaterThanOrEqual(1);

      const second = await deleteStaleCredentials(iso.db, CUTOFF);
      expect(second).toBe(0);
    });
  },
);
