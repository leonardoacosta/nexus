import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";

import { runMigrations } from "../db/migrate";
import {
  insertCredential,
  getCredentialById,
  queryAllCredentials,
  queryCredentialsByStatus,
  updateCredentialStatus,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "./store";
import type { CredentialRow } from "./store";
import { CredentialPool } from "./pool";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function makeCredential(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "cred-001",
    name: "OpenAI Key 1",
    type: "openai",
    value_encrypted: "sk-test-encrypted-value",
    status: "available",
    leased_by: null,
    leased_at: null,
    cooldown_until: null,
    ...overrides,
  };
}

// ─── Store CRUD ───────────────────────────────────────────────────────────────

describe("credential store", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts a credential and retrieves it by id", () => {
    insertCredential(db, makeCredential());

    const row = getCredentialById(db, "cred-001");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("cred-001");
    expect(row!.name).toBe("OpenAI Key 1");
    expect(row!.type).toBe("openai");
    expect(row!.status).toBe("available");
  });

  it("returns null for non-existent credential", () => {
    const row = getCredentialById(db, "does-not-exist");
    expect(row).toBeNull();
  });

  it("queries all credentials", () => {
    insertCredential(db, makeCredential({ id: "c1", name: "Key 1" }));
    insertCredential(db, makeCredential({ id: "c2", name: "Key 2" }));

    const all = queryAllCredentials(db);
    expect(all).toHaveLength(2);
  });

  it("queries credentials by status", () => {
    insertCredential(db, makeCredential({ id: "c1", status: "available" }));
    insertCredential(db, makeCredential({ id: "c2", status: "leased" }));
    insertCredential(db, makeCredential({ id: "c3", status: "available" }));

    const available = queryCredentialsByStatus(db, "available");
    expect(available).toHaveLength(2);

    const leased = queryCredentialsByStatus(db, "leased");
    expect(leased).toHaveLength(1);
    expect(leased[0]!.id).toBe("c2");
  });

  it("updates credential status", () => {
    insertCredential(db, makeCredential({ id: "c1" }));
    const now = new Date().toISOString();

    updateCredentialStatus(db, "c1", "leased", "session-123", now, null);

    const row = getCredentialById(db, "c1");
    expect(row!.status).toBe("leased");
    expect(row!.leased_by).toBe("session-123");
    expect(row!.leased_at).toBe(now);
  });

  it("queries expired cooldowns", () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const futureTime = new Date(Date.now() + 60_000).toISOString();

    insertCredential(
      db,
      makeCredential({ id: "c1", status: "cooldown", cooldown_until: pastTime }),
    );
    insertCredential(
      db,
      makeCredential({ id: "c2", status: "cooldown", cooldown_until: futureTime }),
    );

    const expired = queryExpiredCooldowns(db);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe("c1");
  });

  it("queries stale leases", () => {
    const oldTime = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 hour ago
    const recentTime = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    const threshold = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago

    insertCredential(
      db,
      makeCredential({ id: "c1", status: "leased", leased_at: oldTime }),
    );
    insertCredential(
      db,
      makeCredential({ id: "c2", status: "leased", leased_at: recentTime }),
    );

    const stale = queryStaleLeases(db, threshold);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.id).toBe("c1");
  });
});

// ─── Pool lifecycle ───────────────────────────────────────────────────────────

describe("credential pool — lifecycle", () => {
  let db: Database;
  let pool: CredentialPool;

  beforeEach(() => {
    db = setupDb();
    pool = new CredentialPool(db, { cooldownMs: 100, leaseTtlMs: 200 });
  });
  afterEach(() => {
    pool.stopCleanup();
    db.close();
  });

  it("adds a credential and lists it", () => {
    pool.add({
      id: "c1",
      name: "Key 1",
      type: "openai",
      value_encrypted: "sk-encrypted",
    });

    const list = pool.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("c1");
    expect(list[0]!.status).toBe("available");
    // Ensure value is not exposed
    expect((list[0] as any).value_encrypted).toBeUndefined();
  });

  it("leases a credential and marks it as leased", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });

    const leased = pool.lease("openai", "session-abc");
    expect(leased).not.toBeNull();
    expect(leased!.id).toBe("c1");
    expect(leased!.status).toBe("leased");
    expect(leased!.leased_by).toBe("session-abc");
  });

  it("releases a leased credential back to available", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.lease("openai", "session-abc");

    const released = pool.release("c1");
    expect(released).toBe(true);

    const row = getCredentialById(db, "c1");
    expect(row!.status).toBe("available");
    expect(row!.leased_by).toBeNull();
  });

  it("returns null when pool is exhausted", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.lease("openai", "session-1");

    const second = pool.lease("openai", "session-2");
    expect(second).toBeNull();
  });

  it("returns null when leasing a type that does not exist", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });

    const result = pool.lease("anthropic", "session-1");
    expect(result).toBeNull();
  });

  it("release fails for non-existent credential", () => {
    const result = pool.release("nonexistent");
    expect(result).toBe(false);
  });

  it("release fails for credential not in leased state", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    // Not leased yet — should fail
    const result = pool.release("c1");
    expect(result).toBe(false);
  });

  it("supports lease -> release -> re-lease cycle", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });

    // First lease
    const first = pool.lease("openai", "session-1");
    expect(first).not.toBeNull();

    // Release
    pool.release("c1");

    // Re-lease to different session
    const second = pool.lease("openai", "session-2");
    expect(second).not.toBeNull();
    expect(second!.leased_by).toBe("session-2");
  });
});

// ─── Rate limit rotation ─────────────────────────────────────────────────────

describe("credential pool — rate limit rotation", () => {
  let db: Database;
  let pool: CredentialPool;

  beforeEach(() => {
    db = setupDb();
    pool = new CredentialPool(db, { cooldownMs: 100, leaseTtlMs: 200 });
  });
  afterEach(() => {
    pool.stopCleanup();
    db.close();
  });

  it("puts credential on cooldown and leases next available", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.add({ id: "c2", name: "Key 2", type: "openai", value_encrypted: "sk-2" });

    // Lease first
    pool.lease("openai", "session-1");

    // Report rate limit on first
    const result = pool.reportRateLimit("c1", "session-1");
    expect(result).not.toBeNull();
    expect(result!.cooledDown.status).toBe("cooldown");
    expect(result!.cooledDown.cooldown_until).not.toBeNull();
    expect(result!.next).not.toBeNull();
    expect(result!.next!.id).toBe("c2");
    expect(result!.next!.status).toBe("leased");
  });

  it("returns null for next when pool is exhausted after cooldown", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.lease("openai", "session-1");

    const result = pool.reportRateLimit("c1", "session-1");
    expect(result).not.toBeNull();
    expect(result!.cooledDown.status).toBe("cooldown");
    expect(result!.next).toBeNull();
  });

  it("returns null for non-existent credential", () => {
    const result = pool.reportRateLimit("nonexistent", "session-1");
    expect(result).toBeNull();
  });

  it("recovers from cooldown after expiry", async () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.lease("openai", "session-1");

    // Put on cooldown with 100ms duration
    pool.reportRateLimit("c1", "session-1");

    // Should be on cooldown
    const before = getCredentialById(db, "c1");
    expect(before!.status).toBe("cooldown");

    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Recovery should happen on next lease attempt
    const recovered = pool.recoverExpiredCooldowns();
    expect(recovered).toBe(1);

    const after = getCredentialById(db, "c1");
    expect(after!.status).toBe("available");
  });
});

// ─── Stale lease cleanup ─────────────────────────────────────────────────────

describe("credential pool — stale lease cleanup", () => {
  let db: Database;
  let pool: CredentialPool;

  beforeEach(() => {
    db = setupDb();
    // Very short TTL for testing
    pool = new CredentialPool(db, { cooldownMs: 100, leaseTtlMs: 100 });
  });
  afterEach(() => {
    pool.stopCleanup();
    db.close();
  });

  it("cleans up stale leases after TTL expires", async () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.lease("openai", "session-1");

    // Should be leased
    expect(getCredentialById(db, "c1")!.status).toBe("leased");

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    const cleaned = pool.cleanupStaleLeases();
    expect(cleaned).toBe(1);

    // Should be available again
    expect(getCredentialById(db, "c1")!.status).toBe("available");
  });

  it("does not clean up recent leases", () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.lease("openai", "session-1");

    // Immediately try cleanup — lease is fresh, should not be cleaned
    const cleaned = pool.cleanupStaleLeases();
    expect(cleaned).toBe(0);

    expect(getCredentialById(db, "c1")!.status).toBe("leased");
  });

  it("cleans up multiple stale leases at once", async () => {
    pool.add({ id: "c1", name: "Key 1", type: "openai", value_encrypted: "sk-1" });
    pool.add({ id: "c2", name: "Key 2", type: "openai", value_encrypted: "sk-2" });
    pool.lease("openai", "session-1");
    pool.lease("openai", "session-2");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const cleaned = pool.cleanupStaleLeases();
    expect(cleaned).toBe(2);

    expect(getCredentialById(db, "c1")!.status).toBe("available");
    expect(getCredentialById(db, "c2")!.status).toBe("available");
  });
});
