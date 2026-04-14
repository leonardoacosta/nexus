/**
 * Unit tests for attributeTurnToCredential.
 *
 * Since credential_swaps doesn't exist in the TS schema, all attribution
 * falls back to session-level credential info. Tests mock the DB layer
 * to verify the three fallback cases:
 * 1. Session has credential_id and credential_fingerprint
 * 2. Session has credential_id but no fingerprint (looks up via credentials table)
 * 3. Session not found / no credential
 *
 * Swap-level attribution will be added when credential_swaps is migrated
 * to the TS schema.
 */

import { describe, expect, it } from "bun:test";
import { attributeTurnToCredential } from "./attribution";

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

/**
 * Build a mock Db object that returns the given rows for chained
 * .select().from().where().limit() queries.
 *
 * Supports two sequential calls: the first returns sessionRows,
 * the second (if any) returns credentialRows.
 */
function mockDb(
  sessionRows: Array<Record<string, unknown>>,
  credentialRows: Array<Record<string, unknown>> = [],
) {
  let callCount = 0;
  const db = {
    select: (_fields?: unknown) => {
      const queryIndex = callCount++;
      const rows = queryIndex === 0 ? sessionRows : credentialRows;
      const chain: Record<string, unknown> = {};
      const p = Promise.resolve(rows);
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => p;
      chain.then = p.then.bind(p);
      chain.catch = p.catch.bind(p);
      return chain;
    },
  };
  return db as unknown as import("@nexus/db").Db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attributeTurnToCredential", () => {
  const turnTs = new Date("2026-04-14T19:00:00Z");

  it("returns session credential when session has credentialId and credentialFingerprint", async () => {
    const db = mockDb([
      { credentialId: "cred-A", credentialFingerprint: "fp-A" },
    ]);

    const result = await attributeTurnToCredential(db, "session-1", turnTs);
    expect(result).toEqual({
      credentialId: "cred-A",
      credentialFingerprint: "fp-A",
    });
  });

  it("returns nulls when session is not found", async () => {
    const db = mockDb([]);

    const result = await attributeTurnToCredential(db, "missing-session", turnTs);
    expect(result).toEqual({
      credentialId: null,
      credentialFingerprint: null,
    });
  });

  it("returns nulls when session has no credential assigned", async () => {
    const db = mockDb([
      { credentialId: null, credentialFingerprint: null },
    ]);

    const result = await attributeTurnToCredential(db, "session-2", turnTs);
    expect(result).toEqual({
      credentialId: null,
      credentialFingerprint: null,
    });
  });

  it("looks up fingerprint from credentials table when session has credentialId but no fingerprint", async () => {
    const db = mockDb(
      // Session: has credentialId, but no fingerprint
      [{ credentialId: "cred-B", credentialFingerprint: null }],
      // Credentials lookup: returns the fingerprint
      [{ fingerprint: "fp-B-looked-up" }],
    );

    const result = await attributeTurnToCredential(db, "session-3", turnTs);
    expect(result).toEqual({
      credentialId: "cred-B",
      credentialFingerprint: "fp-B-looked-up",
    });
  });

  it("returns null fingerprint when credential lookup finds nothing", async () => {
    const db = mockDb(
      // Session: has credentialId, but no fingerprint
      [{ credentialId: "cred-C", credentialFingerprint: null }],
      // Credentials lookup: empty result
      [],
    );

    const result = await attributeTurnToCredential(db, "session-4", turnTs);
    expect(result).toEqual({
      credentialId: "cred-C",
      credentialFingerprint: null,
    });
  });
});
