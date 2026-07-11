/**
 * Unit tests for credential-refresh-job.ts.
 *
 * Spec: fix-credential-usage-poller-100pct-failure
 *
 * These cover the per-row tick logic (success / invalid_grant / transient /
 * skip-without-counting) via stub db + pool, mirroring the pure-stub style
 * of credential-usage-poller.test.ts — no real Postgres or network. The
 * WHERE-clause exclusion of the active fingerprint and the real
 * pool.updateSecret() persistence path are covered end-to-end by the live-PG
 * gated suite at the bottom of this file (NEXUS_PG_TESTS=1).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@nexus/db";
import { eq } from "drizzle-orm";
import { credentials } from "@nexus/db";
import { startCredentialRefreshJob } from "./credential-refresh-job";
import type { CredentialPool } from "../credentials/pool";
import { CredentialPool as RealCredentialPool } from "../credentials/pool";
import { __testing as activeTesting } from "../credentials/active-credential-watcher";
import { TEST_KEY, computeCredentialFingerprint } from "../credentials/credentials.helpers";
import { hasLivePg as hasPg } from "../testing/live-pg";
import { createIsolatedSchema, type IsolatedSchema } from "../testing/isolated-pg-schema";

const ROW = { id: "cred-1", fingerprint: "fp-cred-1" };

/** db stub: one refreshable row; captures any update().set() calls. */
function fakeDb(rows: Array<{ id: string; fingerprint: string }>, updateSets: Record<string, unknown>[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        updateSets.push(set);
        return { where: () => Promise.resolve() };
      },
    }),
  } as unknown as Db;
}

const OAUTH_BLOB = (refreshToken: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken } });

describe("credential-refresh-job: tick() per-row handling", () => {
  beforeEach(() => {
    activeTesting.resetSnapshot();
  });

  it("returns zero counters when no rows are due", async () => {
    const svc = startCredentialRefreshJob({
      db: fakeDb([], []),
      pool: { getDecrypted: async () => null } as unknown as CredentialPool,
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result).toEqual({ attempted: 0, succeeded: 0, deadMarked: 0, failed: 0 });
    } finally {
      svc.stop();
    }
  });

  it("skips a row without counting when decrypt yields no plaintext", async () => {
    const svc = startCredentialRefreshJob({
      db: fakeDb([ROW], []),
      pool: { getDecrypted: async () => null } as unknown as CredentialPool,
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result.attempted).toBe(0);
    } finally {
      svc.stop();
    }
  });

  it("skips a row without counting when the blob has no refreshToken", async () => {
    const svc = startCredentialRefreshJob({
      db: fakeDb([ROW], []),
      pool: {
        getDecrypted: async () => JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
      } as unknown as CredentialPool,
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result.attempted).toBe(0);
    } finally {
      svc.stop();
    }
  });

  it("on a successful refresh, calls pool.updateSecret with the new token material", async () => {
    let updateSecretArgs: [string, object, Date] | null = null;
    const pool = {
      getDecrypted: async () => OAUTH_BLOB("old-refresh"),
      updateSecret: async (id: string, blob: object, expiresAt: Date) => {
        updateSecretArgs = [id, blob, expiresAt];
      },
    } as unknown as CredentialPool;

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const svc = startCredentialRefreshJob({
      db: fakeDb([ROW], []),
      pool,
      intervalMs: 1_000_000,
      fetchImpl,
    });
    try {
      const result = await svc.tickOnce();
      expect(result).toEqual({ attempted: 1, succeeded: 1, deadMarked: 0, failed: 0 });
      expect(updateSecretArgs).not.toBeNull();
      const [id, blob] = updateSecretArgs!;
      expect(id).toBe(ROW.id);
      expect((blob as { claudeAiOauth: { accessToken: string; refreshToken: string } }).claudeAiOauth).toMatchObject({
        accessToken: "new-access",
        refreshToken: "new-refresh",
      });
    } finally {
      svc.stop();
    }
  });

  it("on invalid_grant, marks the row refresh_failed and does NOT call updateSecret", async () => {
    let updateSecretCalled = false;
    const updateSets: Record<string, unknown>[] = [];
    const pool = {
      getDecrypted: async () => OAUTH_BLOB("dead-refresh"),
      updateSecret: async () => {
        updateSecretCalled = true;
      },
    } as unknown as CredentialPool;

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_grant", message: "dead" } }),
        { status: 400 },
      )) as unknown as typeof fetch;

    const svc = startCredentialRefreshJob({
      db: fakeDb([ROW], updateSets),
      pool,
      intervalMs: 1_000_000,
      fetchImpl,
    });
    try {
      const result = await svc.tickOnce();
      expect(result).toEqual({ attempted: 1, succeeded: 0, deadMarked: 1, failed: 0 });
      expect(updateSecretCalled).toBe(false);
      expect(updateSets).toContainEqual({ status: "refresh_failed" });
    } finally {
      svc.stop();
    }
  });

  it("on a transient failure, counts it as failed and leaves the row untouched", async () => {
    let updateSecretCalled = false;
    const updateSets: Record<string, unknown>[] = [];
    const pool = {
      getDecrypted: async () => OAUTH_BLOB("some-refresh"),
      updateSecret: async () => {
        updateSecretCalled = true;
      },
    } as unknown as CredentialPool;

    const fetchImpl = (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch;

    const svc = startCredentialRefreshJob({
      db: fakeDb([ROW], updateSets),
      pool,
      intervalMs: 1_000_000,
      fetchImpl,
    });
    try {
      const result = await svc.tickOnce();
      expect(result).toEqual({ attempted: 1, succeeded: 0, deadMarked: 0, failed: 1 });
      expect(updateSecretCalled).toBe(false);
      expect(updateSets).toHaveLength(0);
    } finally {
      svc.stop();
    }
  });
});

// ── Live-PG: active-fingerprint exclusion + real pool.updateSecret() ───────
//
// The stub-db tests above can't meaningfully assert a SQL WHERE-clause
// exclusion (the stub returns a canned array regardless of the drizzle
// condition object). This suite drives the real query + real pool against an
// isolated throwaway schema so the `ne(credentials.fingerprint, active)`
// filter is proven, not assumed. PG-gated on NEXUS_PG_TESTS=1 +
// POSTGRES_URL (skips cleanly otherwise, per credentials.helpers.ts's
// `hasPg` convention).

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

describe.skipIf(!hasPg)("credential-refresh-job: live-PG active-fingerprint exclusion", () => {
  let iso: IsolatedSchema;
  let pool: RealCredentialPool;

  beforeEach(() => {
    activeTesting.resetSnapshot();
  });

  it("refreshes an expiring non-active row and skips the active one", async () => {
    iso = await createIsolatedSchema(CREDENTIALS_DDL, "cred_refresh_job");
    pool = new RealCredentialPool(iso.db, { encryptionKey: TEST_KEY });

    try {
      const suffix = randomUUID().slice(0, 8);
      const activeRefreshToken = `rt-active-${suffix}`;
      const staleRefreshToken = `rt-stale-${suffix}`;
      const soonExpiry = new Date(Date.now() + 5 * 60 * 1000); // within 15min window

      const activeBlob = JSON.stringify({
        claudeAiOauth: { refreshToken: activeRefreshToken, accessToken: "at-active", expiresAt: soonExpiry.getTime() },
      });
      const staleBlob = JSON.stringify({
        claudeAiOauth: { refreshToken: staleRefreshToken, accessToken: "at-stale", expiresAt: soonExpiry.getTime() },
      });

      await pool.add({ id: randomUUID(), name: `acct-active-${suffix}`, type: "oauth", value_plaintext: activeBlob });
      await pool.add({ id: randomUUID(), name: `acct-stale-${suffix}`, type: "oauth", value_plaintext: staleBlob });

      // Both rows were inserted with expiresAt from add()'s metadata extraction;
      // the query threshold is generous (now + 15min) so both are in range.
      const activeFingerprint = computeCredentialFingerprint(activeBlob);
      const staleRow = (
        await iso.db.select().from(credentials).where(eq(credentials.fingerprint, computeCredentialFingerprint(staleBlob)))
      )[0]!;

      // Mark the active row's fingerprint as "currently active" so the job
      // excludes it. This exercises the real getActiveCredentialSnapshot()
      // read path via the watcher's test seam.
      const dir = await mkdtemp(join(tmpdir(), "nx-refresh-job-"));
      const credPath = join(dir, ".credentials.json");
      try {
        await writeFile(credPath, activeBlob);
        const fakeWatcherPool = {
          list: async () => [{ id: "n/a", fingerprint: activeFingerprint }],
          add: async () => "updated" as const,
        };
        await activeTesting.runRefresh(fakeWatcherPool, credPath);

        const refreshedIds: string[] = [];
        const fetchImpl = (async () =>
          new Response(
            JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }),
            { status: 200 },
          )) as unknown as typeof fetch;

        const originalUpdateSecret = pool.updateSecret.bind(pool);
        pool.updateSecret = async (id, blob, expiresAt) => {
          refreshedIds.push(id);
          return originalUpdateSecret(id, blob, expiresAt);
        };

        const svc = startCredentialRefreshJob({ db: iso.db, pool, intervalMs: 1_000_000, fetchImpl });
        try {
          const result = await svc.tickOnce();
          expect(result.attempted).toBe(1);
          expect(result.succeeded).toBe(1);
          expect(refreshedIds).toEqual([staleRow.id]);
        } finally {
          svc.stop();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await iso.drop();
    }
  });
});
