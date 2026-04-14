/**
 * Integration test: mid-session attribution.
 *
 * Since credential_swaps doesn't exist in the TS schema, this test verifies
 * the session-level fallback: all turns for a session with a credential
 * assigned are attributed to that session's credential_id / credential_fingerprint.
 *
 * Uses mock DB (no POSTGRES_URL required).
 *
 * NOTE: Swap-level attribution will be added when credential_swaps is
 * migrated to the TS schema.
 */

import { describe, expect, it } from "bun:test";
import { attributeTurnToCredential } from "./attribution";
import type { Db } from "@nexus/db";

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

function mockSessionDb(
  credentialId: string | null,
  credentialFingerprint: string | null,
) {
  const db = {
    select: (_fields?: unknown) => {
      const rows = [{ credentialId, credentialFingerprint }];
      const p = Promise.resolve(rows);
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => p;
      chain.then = p.then.bind(p);
      chain.catch = p.catch.bind(p);
      return chain;
    },
  };
  return db as unknown as Db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attribution integration: session-level fallback", () => {
  const sessionId = "session-attr-test";

  it("all turns are attributed to the session credential", async () => {
    const db = mockSessionDb("cred-A", "fp-A");

    // Simulate multiple turns at different timestamps
    const turnTimestamps = [
      new Date("2026-04-14T19:00:00Z"),
      new Date("2026-04-14T19:05:00Z"),
      new Date("2026-04-14T19:10:00Z"),
      new Date("2026-04-14T19:15:00Z"),
      new Date("2026-04-14T19:20:00Z"),
    ];

    for (const ts of turnTimestamps) {
      const result = await attributeTurnToCredential(db, sessionId, ts);
      expect(result).toEqual({
        credentialId: "cred-A",
        credentialFingerprint: "fp-A",
      });
    }
  });

  it("turns for a session without credentials return nulls", async () => {
    const db = mockSessionDb(null, null);

    const ts = new Date("2026-04-14T19:00:00Z");
    const result = await attributeTurnToCredential(db, sessionId, ts);
    expect(result).toEqual({
      credentialId: null,
      credentialFingerprint: null,
    });
  });

  it("attribution is consistent across all turns regardless of timestamp", async () => {
    const db = mockSessionDb("cred-B", "fp-B");

    // Even with timestamps that would span a swap boundary in the
    // future swap-based implementation, session-level fallback returns
    // the same credential for all turns
    const earlyTs = new Date("2026-04-14T18:00:00Z");
    const lateTs = new Date("2026-04-14T23:59:59Z");

    const early = await attributeTurnToCredential(db, sessionId, earlyTs);
    const late = await attributeTurnToCredential(db, sessionId, lateTs);

    expect(early).toEqual(late);
    expect(early.credentialId).toBe("cred-B");
    expect(early.credentialFingerprint).toBe("fp-B");
  });
});
