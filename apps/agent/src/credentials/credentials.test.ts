/**
 * Credential system tests.
 *
 * PG-gated suites require a live PostgreSQL connection:
 *   1. Set POSTGRES_URL to the test database
 *   2. Run `pnpm db:push` in packages/db
 *   3. export NEXUS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
 *   4. bun test apps/agent/src/credentials/credentials.test.ts
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { CredentialPool } from "./pool";
import {
  insertCredential,
  getCredentialById,
  queryAllCredentials,
  queryCredentialsByStatus,
  updateCredentialStatus,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "./store";
import { encrypt } from "./encryption";
import type { CredentialRow } from "./store";
import type { Buffer as NodeBuffer } from "node:buffer";
import { openDatabase } from "../db/database";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const hasPg = !!process.env.POSTGRES_URL;

// Test encryption key: 32 bytes, non-zero (non-zero to avoid all-zero key pitfalls)
const TEST_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_KEY: NodeBuffer = Buffer.from(TEST_KEY_HEX, "hex") as NodeBuffer;

/** Generate a unique test credential ID so parallel runs don't collide. */
function testId(base: string): string {
  return `test-cred-${base}-${Date.now()}`;
}

/** Delete credentials by id (cleanup helper). */
async function deleteById(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.delete(credentials).where(eq(credentials.id, id));
  }
}

// ─── Concurrent lease race — unit level ──────────────────────────────────────
//
// We test the transaction-based SELECT FOR UPDATE guard by building a mock DB
// whose `.transaction()` implementation serializes callers:
//   - The first caller receives the available row and updates it to "leased".
//   - Subsequent concurrent callers find no available row and return null.
//
// This mirrors what Postgres SELECT FOR UPDATE does in production.

describe("credential pool — concurrent lease race (unit)", () => {
  // [E2E-1] Exactly one of two simultaneous lease() calls succeeds;
  //         the other returns null (pool exhausted for that slot).
  it("[E2E-1] concurrent lease() calls: exactly one succeeds and one returns null", async () => {
    // The single credential in our in-memory "table".
    // Pre-encrypt the token so the pool can decrypt it on lease
    const encryptedToken = encrypt("tok-secret", TEST_KEY);

    const credential: CredentialRow = {
      id: "cred-race-1",
      name: "race-test",
      type: "anthropic",
      valuePlaintext: null,
      valueEncrypted: encryptedToken,
      encryptionKeyId: "v1",
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 0,
    };

    // Shared mutable state simulating a single-row DB table.
    let tableRow: CredentialRow = { ...credential };
    // Mutex to serialise the critical section, mimicking SELECT FOR UPDATE.
    let txInProgress = false;

    /**
     * A minimal Drizzle-shaped mock that:
     * - `transaction(fn)` — serializes calls (only one at a time)
     * - Within the tx, the builder chain `select().from().where().for().limit(1)`
     *   returns the row if still available, else [].
     * - `update().set().where()` flips the row to "leased".
     */
    /**
     * Build a query builder stub that returns `rows` when awaited at any point
     * in the chain (select / from / where / orderBy / for / limit / etc.).
     * This satisfies both the outer queries (recoverExpiredCooldowns, queryStaleLeases)
     * and the inner transaction queries.
     */
    function makeQueryChain(rows: CredentialRow[]): unknown {
      const p = Promise.resolve(rows);
      // The chain must be thenable so callers can `await chain` or
      // `await chain.where(...)` etc.
      const chain: Record<string, unknown> & PromiseLike<CredentialRow[]> = {
        then: p.then.bind(p),
        catch: p.catch.bind(p),
        finally: p.finally.bind(p),
      };
      // Every method returns the same chain (fluent) so callers can keep chaining.
      for (const method of [
        "select", "from", "where", "for", "orderBy", "limit",
        "and", "lte", "eq",
      ]) {
        chain[method] = (..._args: unknown[]) => chain;
      }
      return chain;
    }

    function makeMockDb(): import("@nexus/db").Db {
      const db = {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          // Serialize concurrent callers — mimics SELECT FOR UPDATE.
          while (txInProgress) {
            await new Promise((r) => setTimeout(r, 0));
          }
          txInProgress = true;
          try {
            const isAvailable = tableRow.status === "available";

            // Optimistically mark as leased so a second concurrent tx sees
            // "leased" and finds an empty result set.
            if (isAvailable) {
              tableRow = {
                ...tableRow,
                status: "leased",
                leasedAt: new Date().toISOString(),
              };
            }

            // Build a transaction proxy: select returns the row iff available.
            const tx = {
              select: () => makeQueryChain(isAvailable ? [{ ...tableRow }] : []),
              update: (_table: unknown) => ({
                set: (vals: Partial<CredentialRow>) => ({
                  where: () => {
                    tableRow = { ...tableRow, ...vals };
                    return Promise.resolve();
                  },
                }),
              }),
            };

            return await fn(tx);
          } finally {
            txInProgress = false;
          }
        },
        // Outer queries (recoverExpiredCooldowns, queryStaleLeases, queryAllCredentials)
        // all use select().from().where()... — return empty arrays (no cooldowns, no stale leases).
        select: () => makeQueryChain([]),
      } as unknown as import("@nexus/db").Db;

      return db;
    }

    const db = makeMockDb();
    const pool = new CredentialPool(db, { encryptionKey: TEST_KEY });

    // Fire both lease calls simultaneously.
    const [result1, result2] = await Promise.all([
      pool.lease("anthropic", "caller-A"),
      pool.lease("anthropic", "caller-B"),
    ]);

    const results = [result1, result2];
    const successes = results.filter((r) => r !== null);
    const nulls = results.filter((r) => r === null);

    // Exactly one winner, one loser.
    expect(successes).toHaveLength(1);
    expect(nulls).toHaveLength(1);

    // The winner should be in "leased" state.
    expect(successes[0]!.status).toBe("leased");
  });
});

// ─── Store CRUD (requires live PG) ──────────────────────────────────────────

describe.skipIf(!hasPg)("credential store (requires live PG)", () => {
  let db: Db;
  const ids: string[] = [];

  beforeAll(() => {
    db = openDatabase();
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  function makeRow(id: string, overrides: Partial<CredentialRow> = {}): CredentialRow {
    return {
      id,
      name: `store-test-${id}`,
      type: "anthropic",
      valuePlaintext: null,
      valueEncrypted: encrypt("secret-value", TEST_KEY),
      encryptionKeyId: "v1",
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 0,
      ...overrides,
    };
  }

  it("inserts a credential and retrieves it by id", async () => {
    const id = testId("insert");
    ids.push(id);
    const row = makeRow(id);
    await insertCredential(db, row);

    const fetched = await getCredentialById(db, id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(id);
    expect(fetched!.name).toBe(row.name);
    expect(fetched!.status).toBe("available");
  });

  it("returns null for non-existent credential", async () => {
    const result = await getCredentialById(db, "does-not-exist-ever");
    expect(result).toBeNull();
  });

  it("queries all credentials", async () => {
    // Seed 3 rows
    const localIds = [testId("all-a"), testId("all-b"), testId("all-c")];
    ids.push(...localIds);
    for (const id of localIds) {
      await insertCredential(db, makeRow(id));
    }

    const all = await queryAllCredentials(db);
    // At least our 3 rows should be present
    const ourIds = new Set(localIds);
    const found = all.filter((r) => ourIds.has(r.id));
    expect(found.length).toBe(3);
  });

  it("queries credentials by status", async () => {
    const availId = testId("status-avail");
    const leasedId = testId("status-leased");
    ids.push(availId, leasedId);

    const now = new Date().toISOString();
    await insertCredential(db, makeRow(availId, { status: "available" }));
    await insertCredential(db, makeRow(leasedId, {
      status: "leased",
      leasedBy: "tester",
      leasedAt: now,
    }));

    const available = await queryCredentialsByStatus(db, "available");
    const leased = await queryCredentialsByStatus(db, "leased");

    expect(available.some((r) => r.id === availId)).toBe(true);
    expect(leased.some((r) => r.id === leasedId)).toBe(true);
    // Available should not include the leased one
    expect(available.some((r) => r.id === leasedId)).toBe(false);
  });

  it("updates credential status", async () => {
    const id = testId("update-status");
    ids.push(id);
    await insertCredential(db, makeRow(id, { status: "available" }));

    const now = new Date().toISOString();
    await updateCredentialStatus(db, id, "leased", "tester", now);

    const updated = await getCredentialById(db, id);
    expect(updated!.status).toBe("leased");
    expect(updated!.leasedBy).toBe("tester");
  });

  it("queries expired cooldowns", async () => {
    const id = testId("expired-cooldown");
    ids.push(id);

    // Set a cooldown that has already passed
    const pastCooldown = new Date(Date.now() - 10_000).toISOString();
    await insertCredential(db, makeRow(id, {
      status: "cooldown",
      cooldownUntil: pastCooldown,
    }));

    const expired = await queryExpiredCooldowns(db);
    expect(expired.some((r) => r.id === id)).toBe(true);
  });

  it("queries stale leases", async () => {
    const id = testId("stale-lease");
    ids.push(id);

    // Leased 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await insertCredential(db, makeRow(id, {
      status: "leased",
      leasedBy: "old-caller",
      leasedAt: twoHoursAgo,
    }));

    // Threshold: anything older than 1 hour is stale
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = await queryStaleLeases(db, oneHourAgo);
    expect(stale.some((r) => r.id === id)).toBe(true);
  });
});

// ─── Pool lifecycle (requires live PG) ──────────────────────────────────────

describe.skipIf(!hasPg)("credential pool — lifecycle (requires live PG)", () => {
  let db: Db;
  let pool: CredentialPool;
  const ids: string[] = [];

  beforeAll(() => {
    db = openDatabase();
    pool = new CredentialPool(db, { encryptionKey: TEST_KEY });
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  it("adds a credential and lists it", async () => {
    const id = testId("lc-add");
    ids.push(id);

    await pool.add({ id, name: `pool-add-${id}`, type: "lc-add-type", value_plaintext: "sk-test" });

    const list = await pool.list();
    expect(list.some((r) => r.id === id)).toBe(true);
  });

  it("leases a credential and marks it as leased", async () => {
    const id = testId("lc-lease");
    ids.push(id);
    // Use a unique type so lease() picks exactly this credential
    const uniqueType = `lc-lease-${Date.now()}`;

    await pool.add({ id, name: `pool-lease-${id}`, type: uniqueType, value_plaintext: "sk-lease" });

    const leased = await pool.lease(uniqueType, "tester-lease");
    expect(leased).not.toBeNull();
    expect(leased!.status).toBe("leased");
    // valueEncrypted field returns the decrypted value after lease()
    expect(leased!.valueEncrypted).toBe("sk-lease");
  });

  it("releases a leased credential back to available", async () => {
    const id = testId("lc-release");
    ids.push(id);
    const uniqueType = `lc-release-${Date.now()}`;

    await pool.add({ id, name: `pool-release-${id}`, type: uniqueType, value_plaintext: "sk-release" });

    // Lease it first
    const leased = await pool.lease(uniqueType, "tester-release");
    expect(leased).not.toBeNull();

    // Release it
    const released = await pool.release(leased!.id);
    expect(released).toBe(true);

    const row = await getCredentialById(db, leased!.id);
    expect(row!.status).toBe("available");
    expect(row!.leasedBy).toBeNull();
  });

  it("returns null when pool is exhausted", async () => {
    const uniqueType = `lc-exhaust-${Date.now()}`;
    const idA = testId("lc-exhaust-a");
    const idB = testId("lc-exhaust-b");
    ids.push(idA, idB);

    await pool.add({ id: idA, name: `pool-exhaust-a`, type: uniqueType, value_plaintext: "sk-a" });
    await pool.add({ id: idB, name: `pool-exhaust-b`, type: uniqueType, value_plaintext: "sk-b" });

    const r1 = await pool.lease(uniqueType, "exhaustion-a");
    const r2 = await pool.lease(uniqueType, "exhaustion-b");
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    // Now pool should be exhausted
    const result = await pool.lease(uniqueType, "should-fail");
    expect(result).toBeNull();

    // Release
    await pool.release(r1!.id);
    await pool.release(r2!.id);
  });

  it("returns null when leasing a type that does not exist", async () => {
    const result = await pool.lease("nonexistent-type-xyz-never", "caller");
    expect(result).toBeNull();
  });

  it("release fails for non-existent credential", async () => {
    const result = await pool.release("does-not-exist-ever");
    expect(result).toBe(false);
  });

  it("release fails for credential not in leased state", async () => {
    const id = testId("lc-not-leased");
    ids.push(id);
    const uniqueType = `lc-not-leased-${Date.now()}`;

    await pool.add({ id, name: `pool-not-leased-${id}`, type: uniqueType, value_plaintext: "sk-notleased" });
    // It's in "available" state — release should fail
    const result = await pool.release(id);
    expect(result).toBe(false);
  });

  it("supports lease -> release -> re-lease cycle", async () => {
    const id = testId("lc-cycle");
    ids.push(id);
    const uniqueType = `lc-cycle-${Date.now()}`;

    await pool.add({ id, name: `pool-cycle-${id}`, type: uniqueType, value_plaintext: "sk-cycle" });

    // Lease
    const leased1 = await pool.lease(uniqueType, "cycle-caller");
    expect(leased1).not.toBeNull();
    expect(leased1!.status).toBe("leased");

    // Release
    await pool.release(leased1!.id);
    const afterRelease = await getCredentialById(db, leased1!.id);
    expect(afterRelease!.status).toBe("available");

    // Re-lease
    const leased2 = await pool.lease(uniqueType, "cycle-caller-2");
    expect(leased2).not.toBeNull();
    expect(leased2!.status).toBe("leased");

    // Cleanup
    await pool.release(leased2!.id);
  });
});

// ─── Rate limit rotation (requires live PG) ────────────────────────────────

describe.skipIf(!hasPg)("credential pool — rate limit rotation (requires live PG)", () => {
  let db: Db;
  let pool: CredentialPool;
  const ids: string[] = [];

  beforeAll(() => {
    db = openDatabase();
    // Short cooldown for tests (100ms)
    pool = new CredentialPool(db, { encryptionKey: TEST_KEY, cooldownMs: 100 });
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  it("puts credential on cooldown and leases next available", async () => {
    const id1 = testId("rl-primary");
    const id2 = testId("rl-secondary");
    ids.push(id1, id2);
    // Use a unique type to isolate from other test credentials in the DB
    const uniqueType = `rl-pair-${Date.now()}`;

    await pool.add({ id: id1, name: `rl-primary-${id1}`, type: uniqueType, value_plaintext: "sk-p" });
    await pool.add({ id: id2, name: `rl-secondary-${id2}`, type: uniqueType, value_plaintext: "sk-s" });

    // Lease the primary
    const leased = await pool.lease(uniqueType, "rl-caller");
    expect(leased).not.toBeNull();

    // Report rate limit — should cool down the primary and lease the secondary
    const result = await pool.reportRateLimit(leased!.id, "rl-caller");
    expect(result).not.toBeNull();
    expect(result!.cooledDown.status).toBe("cooldown");
    // next should be the secondary (id2 is still available)
    expect(result!.next).not.toBeNull();

    // Cleanup
    if (result!.next) {
      await pool.release(result!.next.id);
    }
  });

  it("returns null for next when pool exhausted after cooldown", async () => {
    const id = testId("rl-exhausted");
    ids.push(id);

    await pool.add({ id, name: `rl-exhausted-${id}`, type: "anthropic-solo", value_plaintext: "sk-solo" });

    // Lease the only credential
    const leased = await pool.lease("anthropic-solo", "solo-caller");
    expect(leased).not.toBeNull();

    // Report rate limit — no other anthropic-solo credentials
    const result = await pool.reportRateLimit(leased!.id, "solo-caller");
    expect(result).not.toBeNull();
    expect(result!.cooledDown.status).toBe("cooldown");
    expect(result!.next).toBeNull();
  });

  it("returns null for non-existent credential", async () => {
    const result = await pool.reportRateLimit("does-not-exist-ever", "caller");
    expect(result).toBeNull();
  });

  it("recovers from cooldown after expiry", async () => {
    const id = testId("rl-recover");
    ids.push(id);

    await pool.add({ id, name: `rl-recover-${id}`, type: "anthropic-recover", value_plaintext: "sk-recover" });

    // Put it directly in cooldown with a past cooldownUntil
    const pastCooldown = new Date(Date.now() - 500).toISOString();
    await db
      .update(credentials)
      .set({ status: "cooldown", cooldownUntil: pastCooldown })
      .where(eq(credentials.id, id));

    // recoverExpiredCooldowns should bring it back
    const recovered = await pool.recoverExpiredCooldowns();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const row = await getCredentialById(db, id);
    expect(row!.status).toBe("available");
  });
});

// ─── Stale lease cleanup (requires live PG) ────────────────────────────────

describe.skipIf(!hasPg)("credential pool — stale lease cleanup (requires live PG)", () => {
  let db: Db;
  let pool: CredentialPool;
  const ids: string[] = [];

  beforeAll(() => {
    db = openDatabase();
    // Short TTL for tests: 500ms
    pool = new CredentialPool(db, { encryptionKey: TEST_KEY, leaseTtlMs: 500 });
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  it("cleans up stale leases after TTL expires", async () => {
    const id = testId("sl-stale");
    ids.push(id);

    // Insert with a leasedAt that is well beyond the TTL
    const staleAt = new Date(Date.now() - 2000).toISOString();
    await db.insert(credentials).values({
      id,
      name: `sl-stale-${id}`,
      type: "anthropic",
      valuePlaintext: null,
      valueEncrypted: encrypt("sk-stale", TEST_KEY),
      encryptionKeyId: "v1",
      status: "leased",
      leasedBy: "old-caller",
      leasedAt: staleAt,
      cooldownUntil: null,
      rateLimitCount: 0,
    });

    const cleaned = await pool.cleanupStaleLeases();
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const row = await getCredentialById(db, id);
    expect(row!.status).toBe("available");
    expect(row!.leasedBy).toBeNull();
  });

  it("does not clean up recent leases", async () => {
    const id = testId("sl-fresh");
    ids.push(id);

    // Insert with a very recent leasedAt
    const freshAt = new Date().toISOString();
    await db.insert(credentials).values({
      id,
      name: `sl-fresh-${id}`,
      type: "anthropic",
      valuePlaintext: null,
      valueEncrypted: encrypt("sk-fresh", TEST_KEY),
      encryptionKeyId: "v1",
      status: "leased",
      leasedBy: "fresh-caller",
      leasedAt: freshAt,
      cooldownUntil: null,
      rateLimitCount: 0,
    });

    await pool.cleanupStaleLeases();

    const row = await getCredentialById(db, id);
    // Should still be leased — fresh lease was not stale
    expect(row!.status).toBe("leased");

    // Release for cleanup
    await db
      .update(credentials)
      .set({ status: "available", leasedBy: null, leasedAt: null })
      .where(eq(credentials.id, id));
  });

  it("cleans up multiple stale leases at once", async () => {
    const id1 = testId("sl-multi-a");
    const id2 = testId("sl-multi-b");
    const id3 = testId("sl-multi-c");
    ids.push(id1, id2, id3);

    const staleAt = new Date(Date.now() - 2000).toISOString();
    for (const id of [id1, id2, id3]) {
      await db.insert(credentials).values({
        id,
        name: `sl-multi-${id}`,
        type: "anthropic",
        valuePlaintext: null,
        valueEncrypted: encrypt("sk-multi", TEST_KEY),
        encryptionKeyId: "v1",
        status: "leased",
        leasedBy: "old-caller",
        leasedAt: staleAt,
        cooldownUntil: null,
        rateLimitCount: 0,
      });
    }

    const cleaned = await pool.cleanupStaleLeases();
    expect(cleaned).toBeGreaterThanOrEqual(3);

    for (const id of [id1, id2, id3]) {
      const row = await getCredentialById(db, id);
      expect(row!.status).toBe("available");
    }
  });
});
