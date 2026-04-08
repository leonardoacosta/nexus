/**
 * Credential store CRUD tests (requires live PG).
 *
 * PG-gated suites require a live PostgreSQL connection:
 *   1. Set POSTGRES_URL to the test database
 *   2. Run `pnpm db:push` in packages/db
 *   3. export NEXUS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
 *   4. bun test apps/agent/src/credentials/credential-crud.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  insertCredential,
  getCredentialById,
  queryAllCredentials,
  queryCredentialsByStatus,
  updateCredentialStatus,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "./store";
import type { Db } from "@nexus/db";
import { hasPg, TEST_KEY, testId, deleteById, makeRow, createTestDb } from "./credentials.helpers";

// ─── Store CRUD (requires live PG) ──────────────────────────────────────────

describe.skipIf(!hasPg)("credential store (requires live PG)", () => {
  let db: Db;
  const ids: string[] = [];

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(async () => {
    await deleteById(db, ids);
  });

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
