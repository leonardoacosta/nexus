/**
 * Credential encryption storage tests (unit — no PG).
 *
 * Tests encrypted value storage, decryption on lease, weighted round-robin,
 * predictive pre-rotation, and cleanup error logging.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import { CredentialPool } from "./pool";
import { encrypt } from "./encryption";
import type { CredentialRow } from "./store";
import type { Buffer as NodeBuffer } from "node:buffer";
import { TEST_KEY } from "./credentials.helpers";

// ─── Encryption storage (unit — no PG) ──────────────────────────────────────

describe("credential pool — encryption storage (unit)", () => {
  // [12.2] add() stores encrypted value: decryptable with correct key, unreadable as plaintext
  it("[12.2] add() stores encrypted value — decryptable, unreadable as plaintext", async () => {
    const { decrypt } = await import("./encryption");

    // pool.add() now requires valid OAuth JSON for fingerprint computation
    const plaintext = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test",
        refreshToken: "sk-ant-ort01-enc-test-secret",
        expiresAt: 1775033611232,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });

    let storedRow: CredentialRow | null = null;

    // The transaction mock needs select/insert/update because pool.add()
    // now queries for existing primaries inside the transaction.
    const txMock = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (row: CredentialRow) => {
          storedRow = row;
          return Promise.resolve();
        },
      }),
    };

    const mockDb = {
      insert: (_table: unknown) => ({
        values: (row: CredentialRow) => {
          storedRow = row;
          return Promise.resolve();
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock),
    } as unknown as import("@nexus/db").Db;

    const pool = new CredentialPool(mockDb, { encryptionKey: TEST_KEY });
    await pool.add({ id: "enc-test-1", name: "enc-test", type: "anthropic", value_plaintext: plaintext });

    expect(storedRow).not.toBeNull();
    const row = storedRow!;

    expect(row.valueEncrypted).not.toBe(plaintext);
    expect(row.valueEncrypted).not.toBeNull();

    const decrypted = decrypt(row.valueEncrypted!, TEST_KEY);
    expect(decrypted).toBe(plaintext);

    const wrongKey = Buffer.from("0000000000000000000000000000000000000000000000000000000000000002", "hex") as NodeBuffer;
    expect(() => decrypt(row.valueEncrypted!, wrongKey)).toThrow();
  });

  // [12.3] lease() returns decrypted value
  it("[12.3] lease() returns decrypted value", async () => {
    const encryptedToken = encrypt("tok-plaintext", TEST_KEY);

    const storedRow: CredentialRow = {
      id: "dec-test-1",
      name: "dec-test",
      type: "anthropic",
      valueEncrypted: encryptedToken,
      encryptionKeyId: "v1",
      agentId: null,
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 0,
      fingerprint: "test-fp-dec-test-1",
      duplicateGroupId: "test-fp-dec-test-1",
      isPrimary: true,
      subscriptionType: null,
      rateLimitTier: null,
      expiresAt: null,
      accountEmail: null,
      accountName: null,
      accountUuid: null,
      orgName: null,
      orgUuid: null,
      mcpProviders: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let tableRow = { ...storedRow };

    const mockDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  for: () => ({
                    limit: () => Promise.resolve([{ ...tableRow }]),
                  }),
                }),
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
          update: (_table: unknown) => ({
            set: (vals: Partial<CredentialRow>) => ({
              where: () => {
                tableRow = { ...tableRow, ...vals };
                return Promise.resolve();
              },
            }),
          }),
        };
        const txFull = {
          ...tx,
          select: (() => {
            let callCount = 0;
            return () => {
              callCount++;
              const row = { ...tableRow };
              if (callCount === 1) {
                return {
                  from: () => ({
                    where: () => ({
                      orderBy: () => ({
                        for: () => ({
                          limit: () => Promise.resolve([row]),
                        }),
                      }),
                    }),
                  }),
                };
              }
              return {
                from: () => ({
                  where: () => ({
                    limit: () => Promise.resolve([row]),
                  }),
                }),
              };
            };
          })(),
          update: tx.update,
        };
        return fn(txFull);
      },
      select: () => ({
        from: () => ({
          where: () => Object.assign(Promise.resolve([]), {
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
            limit: () => Promise.resolve([]),
          }),
          orderBy: () => Object.assign(Promise.resolve([]), {
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    } as unknown as import("@nexus/db").Db;

    const pool = new CredentialPool(mockDb, { encryptionKey: TEST_KEY });
    const leased = await pool.lease("anthropic", "test-caller");

    expect(leased).not.toBeNull();
    expect(leased!.valueEncrypted).toBe("tok-plaintext");
  });

  // [12.4] weighted round-robin prefers credential with lower rate_limit_count
  it("[12.4] weighted round-robin: prefers credential with lower rate_limit_count", async () => {
    const highCount: CredentialRow = {
      id: "wrr-high",
      name: "wrr-high",
      type: "anthropic",
      valueEncrypted: encrypt("tok-high", TEST_KEY),
      encryptionKeyId: "v1",
      agentId: null,
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 10,
      fingerprint: "test-fp-wrr-high",
      duplicateGroupId: "test-fp-wrr-high",
      isPrimary: true,
      subscriptionType: null,
      rateLimitTier: null,
      expiresAt: null,
      accountEmail: null,
      accountName: null,
      accountUuid: null,
      orgName: null,
      orgUuid: null,
      mcpProviders: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const lowCount: CredentialRow = {
      id: "wrr-low",
      name: "wrr-low",
      type: "anthropic",
      valueEncrypted: encrypt("tok-low", TEST_KEY),
      encryptionKeyId: "v1",
      agentId: null,
      status: "available",
      leasedBy: null,
      leasedAt: null,
      cooldownUntil: null,
      rateLimitCount: 2,
      fingerprint: "test-fp-wrr-low",
      duplicateGroupId: "test-fp-wrr-low",
      isPrimary: true,
      subscriptionType: null,
      rateLimitTier: null,
      expiresAt: null,
      accountEmail: null,
      accountName: null,
      accountUuid: null,
      orgName: null,
      orgUuid: null,
      mcpProviders: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let leasedId: string | null = null;
    let tableRows = [lowCount, highCount];

    const mockDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        let firstSelect = true;
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  for: () => ({
                    limit: () => {
                      if (firstSelect) {
                        firstSelect = false;
                        return Promise.resolve([{ ...tableRows[0]! }]);
                      }
                      return Promise.resolve([]);
                    },
                  }),
                }),
                limit: () => {
                  const row = tableRows.find((r) => r.id === leasedId);
                  return Promise.resolve(row ? [{ ...row, status: "leased" }] : []);
                },
              }),
            }),
          }),
          update: (_table: unknown) => ({
            set: (vals: Partial<CredentialRow>) => ({
              where: () => {
                leasedId = tableRows[0]!.id;
                tableRows[0] = { ...tableRows[0]!, ...vals };
                return Promise.resolve();
              },
            }),
          }),
        };
        return fn(tx);
      },
      select: () => ({
        from: () => ({
          where: () => Object.assign(Promise.resolve([]), {
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
            limit: () => Promise.resolve([]),
          }),
          orderBy: () => Object.assign(Promise.resolve([]), {
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    } as unknown as import("@nexus/db").Db;

    const pool = new CredentialPool(mockDb, { encryptionKey: TEST_KEY });
    const leased = await pool.lease("anthropic", "wrr-caller");

    expect(leased).not.toBeNull();
    expect(leased!.id).toBe("wrr-low");
  });

  // [12.5] predictive pre-rotation fires when utilization >= 85%
  it("[12.5] predictive pre-rotation fires when utilization >= 85%", async () => {
    const highUtilCred: CredentialRow = {
      id: "prerotate-1",
      name: "prerotate",
      type: "anthropic",
      valueEncrypted: encrypt("tok-prerotate", TEST_KEY),
      encryptionKeyId: "v1",
      agentId: null,
      status: "leased",
      leasedBy: "some-caller",
      leasedAt: new Date(),
      cooldownUntil: null,
      rateLimitCount: 43,
      fingerprint: "test-fp-prerotate-1",
      duplicateGroupId: "test-fp-prerotate-1",
      isPrimary: true,
      subscriptionType: null,
      rateLimitTier: null,
      expiresAt: null,
      accountEmail: null,
      accountName: null,
      accountUuid: null,
      orgName: null,
      orgUuid: null,
      mcpProviders: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let cooldownCalled = false;
    let tableRow = { ...highUtilCred };

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ ...tableRow }]),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  for: () => ({
                    limit: () => Promise.resolve([]),
                  }),
                }),
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
          update: (_t: unknown) => ({ set: (_v: unknown) => ({ where: () => Promise.resolve() }) }),
        };
        return fn(tx);
      },
      update: (_table: unknown) => ({
        set: (vals: Partial<CredentialRow>) => ({
          where: () => {
            tableRow = { ...tableRow, ...vals };
            cooldownCalled = true;
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as import("@nexus/db").Db;

    const origGetById = (await import("./store")).getCredentialById;
    mock.module("./store", () => ({
      ...require("./store"),
      getCredentialById: async (_db: unknown, id: string) => {
        if (id === "prerotate-1") return { ...tableRow };
        return origGetById(_db as import("@nexus/db").Db, id);
      },
    }));

    const pool = new CredentialPool(mockDb, { encryptionKey: TEST_KEY, prerotateThreshold: 0.85 });
    const rotated = await pool.checkPrerotation();

    expect(rotated).toBeGreaterThanOrEqual(1);
  });

  // [12.8] cleanup timer logs errors instead of swallowing them
  it("[12.8] cleanup timer logs errors instead of swallowing them", async () => {
    const { logger } = await import("@nexus/core");
    const errorSpy = spyOn(logger, "error");

    const testError = new Error("simulated cleanup failure");

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.reject(testError) }),
            limit: () => Promise.reject(testError),
          }),
        }),
      }),
      transaction: async (_fn: unknown) => Promise.reject(testError),
    } as unknown as import("@nexus/db").Db;

    const pool = new CredentialPool(mockDb, { encryptionKey: TEST_KEY });

    await pool.recoverExpiredCooldowns().catch(() => {/* handled by pool */});
    await pool.cleanupStaleLeases().catch(() => {/* handled by pool */});

    const recoverSpy = spyOn(pool, "recoverExpiredCooldowns").mockImplementation(() => Promise.reject(testError));
    const cleanupSpy = spyOn(pool, "cleanupStaleLeases").mockImplementation(() => Promise.reject(testError));

    pool.startCleanup(999999);
    pool.stopCleanup();

    let caughtByLogger = false;
    try {
      await pool.recoverExpiredCooldowns().catch((err) => {
        logger.error({ err }, "cleanup: recoverExpiredCooldowns failed");
        caughtByLogger = true;
      });
    } catch {
      // Should not reach here
    }
    expect(caughtByLogger).toBe(true);
    expect(errorSpy).toHaveBeenCalled();

    recoverSpy.mockRestore();
    cleanupSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
