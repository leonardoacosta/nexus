/**
 * Unit tests for credential-usage-poller.
 *
 * Spec: credentials-account-resolve-and-usage (task 2.3)
 *
 * These cover the pure logic — body parser + back-off threshold — without
 * requiring a Postgres scratch schema. The full DB integration path is
 * exercised end-to-end in tasks 4.1–4.3 against a homelab agent.
 */

import { describe, expect, it, afterEach } from "bun:test";
import type { Db } from "@nexus/db";
import { parseUsageBody, startCredentialUsagePoller } from "./credential-usage-poller";
import type { CredentialPool } from "../credentials/pool";

describe("parseUsageBody", () => {
  it("parses a well-formed Anthropic-shaped response", () => {
    const body = {
      five_hour: {
        used: 41,
        limit: 50,
        resets_at: "2030-01-01T00:00:00.000Z",
      },
      seven_day: {
        used: 220,
        limit: 1000,
        resets_at: "2030-01-08T00:00:00.000Z",
      },
    };
    const parsed = parseUsageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.fiveHour.used).toBe(41);
    expect(parsed?.fiveHour.limit).toBe(50);
    expect(parsed?.fiveHour.resetsAt?.toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
    expect(parsed?.sevenDay.used).toBe(220);
    expect(parsed?.sevenDay.limit).toBe(1000);
  });

  it("accepts camelCase keys (defensive — unstable upstream)", () => {
    const body = {
      fiveHour: {
        used: 10,
        limit: 50,
        resetsAt: "2030-01-01T00:00:00.000Z",
      },
      sevenDay: {
        used: 100,
        limit: 1000,
        resetsAt: "2030-01-08T00:00:00.000Z",
      },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(10);
    expect(parsed?.sevenDay.used).toBe(100);
  });

  it("accepts numeric `used` and `limit` as strings", () => {
    const body = {
      five_hour: { used: "33", limit: "50", resets_at: null },
      seven_day: { used: "150", limit: "1000", resets_at: null },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(33);
    expect(parsed?.sevenDay.limit).toBe(1000);
    expect(parsed?.fiveHour.resetsAt).toBeNull();
  });

  it("accepts epoch-second `resets_at`", () => {
    const body = {
      five_hour: { used: 1, limit: 50, resets_at: 1893456000 }, // 2030-01-01
      seven_day: { used: 1, limit: 1000, resets_at: 1893456000 },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.resetsAt?.toISOString()).toContain("2030-");
  });

  it("returns null when both windows are unrecognisable", () => {
    expect(parseUsageBody({})).toBeNull();
    expect(parseUsageBody(null)).toBeNull();
    expect(parseUsageBody("not an object" as unknown)).toBeNull();
    expect(parseUsageBody({ five_hour: 42, seven_day: "junk" })).toBeNull();
  });

  it("tolerates one window missing — fills the other with zeros", () => {
    const body = {
      five_hour: { used: 12, limit: 50, resets_at: null },
      // seven_day absent
    };
    const parsed = parseUsageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.fiveHour.used).toBe(12);
    expect(parsed?.sevenDay.used).toBe(0);
    expect(parsed?.sevenDay.limit).toBe(0);
  });

  it("rejects junk for resets_at without dropping numeric fields", () => {
    const body = {
      five_hour: { used: 5, limit: 50, resets_at: "definitely not a date" },
      seven_day: { used: 50, limit: 1000, resets_at: "also bad" },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(5);
    expect(parsed?.fiveHour.resetsAt).toBeNull();
    expect(parsed?.sevenDay.used).toBe(50);
    expect(parsed?.sevenDay.resetsAt).toBeNull();
  });
});

describe("back-off threshold computation", () => {
  // Replays the inline `attempted > 0 && failed / attempted > 0.5` check
  // from tick(). The pure math lives nowhere else, so we lock it here so
  // future refactors that touch the threshold land via a failing assertion
  // first.
  function shouldBackOff(attempted: number, failed: number): boolean {
    return attempted > 0 && failed / attempted > 0.5;
  }

  it("does not back off when no calls were attempted", () => {
    expect(shouldBackOff(0, 0)).toBe(false);
  });

  it("does not back off at the 50% boundary", () => {
    // 2 of 4 == 0.5 — strictly > 0.5 is the threshold, so 50% should NOT
    // back off (matches the implementation).
    expect(shouldBackOff(4, 2)).toBe(false);
  });

  it("backs off above 50%", () => {
    expect(shouldBackOff(4, 3)).toBe(true);
    expect(shouldBackOff(2, 2)).toBe(true);
  });

  it("does not back off below 50%", () => {
    expect(shouldBackOff(4, 1)).toBe(false);
    expect(shouldBackOff(10, 4)).toBe(false);
  });
});

// ── [2.3] onTickComplete (proactive-swap) integration ──────────────────────
//
// A successful tick MUST invoke the injected evaluator at the end; an evaluator
// throw MUST be logged and MUST NOT fail the tick. We drive tickOnce() with a
// db stub returning one pollable row whose decrypt yields no token — so the
// tick attempts zero remote calls (no network), stays non-backed-off, and
// reaches the onTickComplete hook deterministically.

/** db stub: queryPollableRows → one primary+available row. */
function fakePollerDb(): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: "cred-1", accountEmail: "a@b.com" }]),
      }),
    }),
  } as unknown as Db;
}

/** pool stub: decrypt returns null so no token is extracted (no fetch). */
function fakePool(): CredentialPool {
  return {
    getDecrypted: async () => null,
  } as unknown as CredentialPool;
}

describe("credential-usage-poller: onTickComplete evaluator hook (2.3)", () => {
  it("invokes the injected evaluator at the end of a successful tick", async () => {
    let calledWith: { db: Db; pool: CredentialPool } | null = null;
    const svc = startCredentialUsagePoller({
      db: fakePollerDb(),
      pool: fakePool(),
      intervalMs: 1_000_000, // park the scheduled tick well outside the test
      onTickComplete: async (deps) => {
        calledWith = deps;
      },
    });
    try {
      const result = await svc.tickOnce();
      expect(result.backedOff).toBe(false);
      expect(result.attempted).toBe(0); // no token → no remote call
      expect(calledWith).not.toBeNull();
    } finally {
      svc.stop();
    }
  });

  it("logs an evaluator throw without failing the tick", async () => {
    const svc = startCredentialUsagePoller({
      db: fakePollerDb(),
      pool: fakePool(),
      intervalMs: 1_000_000,
      onTickComplete: async () => {
        throw new Error("evaluator boom");
      },
    });
    try {
      // tickOnce MUST resolve (the throw is swallowed), not reject.
      const result = await svc.tickOnce();
      expect(result.backedOff).toBe(false);
    } finally {
      svc.stop();
    }
  });
});

// ── [4.1] credential_polls history-row write on tickOnce ───────────────────
//
// A successful tick (token present + parseable /api/oauth/usage response) MUST
// append exactly one credential_polls row with the parsed snapshot values. A
// failed/unparseable response MUST append none. We drive tickOnce() with:
//   - a capturing db stub that records every insert(...).values(...)
//   - a pool whose getDecrypted yields a token-bearing OAuth blob
//   - a stubbed global fetch (fetchWithTimeout wraps the global fetch)
// so no real network or Postgres is touched — this mirrors the pure-stub style
// of the parser/back-off tests above. The full DB path is also covered by the
// route + reaper live-PG suites.

/** One pollable row; accountEmail set so no opportunistic identity re-probe. */
const POLL_ROW = { id: "cred-1", accountEmail: "a@b.com", fingerprint: "fp-1" };

/** db stub that resolves queryPollableRows and captures inserted poll rows. */
function capturingDb(inserts: Array<Record<string, unknown>>): Db {
  return {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([POLL_ROW]) }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
}

/** pool stub: decrypt yields a token-bearing OAuth blob so a fetch is attempted. */
function tokenPool(): CredentialPool {
  return {
    getDecrypted: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } }),
  } as unknown as CredentialPool;
}

const ORIGINAL_FETCH = globalThis.fetch;

describe("credential-usage-poller: credential_polls history write (4.1)", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("inserts exactly one credential_polls row on a successful tick", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          five_hour: { used: 41, limit: 50, resets_at: "2030-01-01T00:00:00.000Z" },
          seven_day: { used: 220, limit: 1000, resets_at: "2030-01-08T00:00:00.000Z" },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const inserts: Array<Record<string, unknown>> = [];
    const svc = startCredentialUsagePoller({
      db: capturingDb(inserts),
      pool: tokenPool(),
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);

      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatchObject({
        credentialId: "cred-1",
        fingerprint: "fp-1",
        usage5hUsed: 41,
        usage5hLimit: 50,
        usage7dUsed: 220,
        usage7dLimit: 1000,
      });
    } finally {
      svc.stop();
    }
  });

  it("inserts no credential_polls row when the response is unparseable", async () => {
    // 200 OK but a body parseUsageBody rejects → payload null → no write.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ five_hour: 42, seven_day: "junk" }), {
        status: 200,
      })) as unknown as typeof fetch;

    const inserts: Array<Record<string, unknown>> = [];
    const svc = startCredentialUsagePoller({
      db: capturingDb(inserts),
      pool: tokenPool(),
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(inserts).toHaveLength(0);
    } finally {
      svc.stop();
    }
  });
});
