/**
 * Credential pool lifecycle tests — lease/release/cooldown/stale-cleanup.
 *
 * Includes both unit-level concurrent race tests and PG-gated lifecycle tests.
 *
 * PG-gated suites require a live PostgreSQL connection:
 *   1. Set POSTGRES_URL to the test database
 *   2. Run `pnpm db:push` in packages/db
 *   3. export NEXUS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
 *   4. bun test apps/agent/src/credentials/credential-pool.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { CredentialPool } from "./pool";
import { getCredentialById } from "./store";
import { encrypt } from "./encryption";
import type { CredentialRow } from "./store";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import { hasPg, TEST_KEY, testId, deleteById, makeQueryChain, createTestDb } from "./credentials.helpers";

// ─── Concurrent lease race — unit level ──────────────────────────────────────

describe("credential pool — concurrent lease race (unit)", () => {
  it("[E2E-1] concurrent lease() calls: exactly one succeeds and one returns null", async () => {
    const encryptedToken = encrypt("tok-secret", TEST_KEY);

    const credential: CredentialRow = {
      id: "cred-race-1",
      name: "race-test",
      type: "anthropic",
      valueEncrypted: encryptedToken,
      encryptionKeyId: "v1",
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 0,
    };

    let tableRow: CredentialRow = { ...credential };
    let txInProgress = false;

    function makeMockDb(): Db {
      const db = {
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          while (txInProgress) {
            await new Promise((r) => setTimeout(r, 0));
          }
          txInProgress = true;
          try {
            const isAvailable = tableRow.status === "available";

            if (isAvailable) {
              tableRow = {
                ...tableRow,
                status: "leased",
                leasedAt: new Date(),
              };
            }

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
        select: () => makeQueryChain([]),
      } as unknown as Db;

      return db;
    }

    const db = makeMockDb();
    const pool = new CredentialPool(db, { encryptionKey: TEST_KEY });

    const [result1, result2] = await Promise.all([
      pool.lease("anthropic", "caller-A"),
      pool.lease("anthropic", "caller-B"),
    ]);

    const results = [result1, result2];
    const successes = results.filter((r) => r !== null);
    const nulls = results.filter((r) => r === null);

    expect(successes).toHaveLength(1);
    expect(nulls).toHaveLength(1);
    expect(successes[0]!.status).toBe("leased");
  });
});

// ─── Pool lifecycle (requires live PG) ──────────────────────────────────────

describe.skipIf(!hasPg)("credential pool — lifecycle (requires live PG)", () => {
  let db: Db;
  let pool: CredentialPool;
  const ids: string[] = [];

  beforeAll(() => {
    db = createTestDb();
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
    const uniqueType = `lc-lease-${Date.now()}`;

    await pool.add({ id, name: `pool-lease-${id}`, type: uniqueType, value_plaintext: "sk-lease" });

    const leased = await pool.lease(uniqueType, "tester-lease");
    expect(leased).not.toBeNull();
    expect(leased!.status).toBe("leased");
    expect(leased!.valueEncrypted).toBe("sk-lease");
  });

  it("releases a leased credential back to available", async () => {
    const id = testId("lc-release");
    ids.push(id);
    const uniqueType = `lc-release-${Date.now()}`;

    await pool.add({ id, name: `pool-release-${id}`, type: uniqueType, value_plaintext: "sk-release" });

    const leased = await pool.lease(uniqueType, "tester-release");
    expect(leased).not.toBeNull();

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

    const result = await pool.lease(uniqueType, "should-fail");
    expect(result).toBeNull();

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
    const result = await pool.release(id);
    expect(result).toBe(false);
  });

  it("supports lease -> release -> re-lease cycle", async () => {
    const id = testId("lc-cycle");
    ids.push(id);
    const uniqueType = `lc-cycle-${Date.now()}`;

    await pool.add({ id, name: `pool-cycle-${id}`, type: uniqueType, value_plaintext: "sk-cycle" });

    const leased1 = await pool.lease(uniqueType, "cycle-caller");
    expect(leased1).not.toBeNull();
    expect(leased1!.status).toBe("leased");

    await pool.release(leased1!.id);
    const afterRelease = await getCredentialById(db, leased1!.id);
    expect(afterRelease!.status).toBe("available");

    const leased2 = await pool.lease(uniqueType, "cycle-caller-2");
    expect(leased2).not.toBeNull();
    expect(leased2!.status).toBe("leased");

    await pool.release(leased2!.id);
  });
});

// ─── Rate limit rotation (requires live PG) ────────────────────────────────

describe.skipIf(!hasPg)("credential pool — rate limit rotation (requires live PG)", () => {
  let db: Db;
  let pool: CredentialPool;
  const ids: string[] = [];

  beforeAll(() => {
    db = createTestDb();
    pool = new CredentialPool(db, { encryptionKey: TEST_KEY, cooldownMs: 100 });
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  it("puts credential on cooldown and leases next available", async () => {
    const id1 = testId("rl-primary");
    const id2 = testId("rl-secondary");
    ids.push(id1, id2);
    const uniqueType = `rl-pair-${Date.now()}`;

    await pool.add({ id: id1, name: `rl-primary-${id1}`, type: uniqueType, value_plaintext: "sk-p" });
    await pool.add({ id: id2, name: `rl-secondary-${id2}`, type: uniqueType, value_plaintext: "sk-s" });

    const leased = await pool.lease(uniqueType, "rl-caller");
    expect(leased).not.toBeNull();

    const result = await pool.reportRateLimit(leased!.id, "rl-caller");
    expect(result).not.toBeNull();
    expect(result!.cooledDown.status).toBe("cooldown");
    expect(result!.next).not.toBeNull();

    if (result!.next) {
      await pool.release(result!.next.id);
    }
  });

  it("returns null for next when pool exhausted after cooldown", async () => {
    const id = testId("rl-exhausted");
    ids.push(id);

    await pool.add({ id, name: `rl-exhausted-${id}`, type: "anthropic-solo", value_plaintext: "sk-solo" });

    const leased = await pool.lease("anthropic-solo", "solo-caller");
    expect(leased).not.toBeNull();

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

    const pastCooldown = new Date(Date.now() - 500);
    await db
      .update(credentials)
      .set({ status: "cooldown", cooldownUntil: pastCooldown })
      .where(eq(credentials.id, id));

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
    db = createTestDb();
    pool = new CredentialPool(db, { encryptionKey: TEST_KEY, leaseTtlMs: 500 });
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

  it("cleans up stale leases after TTL expires", async () => {
    const id = testId("sl-stale");
    ids.push(id);

    const staleAt = new Date(Date.now() - 2000);
    await db.insert(credentials).values({
      id,
      name: `sl-stale-${id}`,
      type: "anthropic",
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

    const freshAt = new Date();
    await db.insert(credentials).values({
      id,
      name: `sl-fresh-${id}`,
      type: "anthropic",
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
    expect(row!.status).toBe("leased");

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

    const staleAt = new Date(Date.now() - 2000);
    for (const id of [id1, id2, id3]) {
      await db.insert(credentials).values({
        id,
        name: `sl-multi-${id}`,
        type: "anthropic",
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
