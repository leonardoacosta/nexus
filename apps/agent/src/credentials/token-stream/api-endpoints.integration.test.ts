/**
 * Integration test: API endpoints for token stream.
 *
 * Tests the handler functions directly with mock DB:
 * 1. GET /sessions/{id}/tokens — returns turns array + aggregates
 * 2. GET /credentials/{id}/usage?window=24h — fingerprint-level rollup
 * 3. GET /credentials/{id}/usage?window=invalid — returns 400
 *
 * Uses mock DB (no POSTGRES_URL required).
 */

import { describe, expect, it } from "bun:test";
import { handleGetSessionTokens } from "../../routes/sessions";
import { handleCredentialUsage } from "../../routes/credentials";
import type { Db } from "@nexus/db";

// ---------------------------------------------------------------------------
// Mock DB builders
// ---------------------------------------------------------------------------

/**
 * Build a mock Db for handleGetSessionTokens.
 *
 * The handler does two queries:
 * 1. getSessionById: select().from(sessions).where(...).limit(1)
 * 2. select().from(sessionTokenTurns).where(...).orderBy(...)
 */
function mockDbForSessionTokens(
  sessionExists: boolean,
  tokenTurns: Array<Record<string, unknown>>,
) {
  let callCount = 0;

  const db = {
    select: (_fields?: unknown) => {
      const queryIndex = callCount++;
      const chain: Record<string, unknown> = {};

      if (queryIndex === 0) {
        // getSessionById query
        const rows = sessionExists
          ? [{ id: "session-1", status: "active" }]
          : [];
        const p = Promise.resolve(rows);
        chain.from = () => chain;
        chain.where = () => chain;
        chain.limit = () => p;
        chain.orderBy = () => chain;
        chain.then = p.then.bind(p);
        chain.catch = p.catch.bind(p);
      } else {
        // sessionTokenTurns query
        const p = Promise.resolve(tokenTurns);
        chain.from = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => p;
        chain.limit = () => p;
        chain.then = p.then.bind(p);
        chain.catch = p.catch.bind(p);
      }
      return chain;
    },
  };

  return db as unknown as Db;
}

/**
 * Build a mock Db for handleCredentialUsage.
 *
 * The handler does two queries:
 * 1. select credentials by id (to get fingerprint)
 * 2. aggregate sessionTokenTurns by fingerprint
 */
function mockDbForCredentialUsage(
  credentialExists: boolean,
  fingerprint: string,
  aggregateRow: Record<string, unknown>,
) {
  let callCount = 0;

  const db = {
    select: (_fields?: unknown) => {
      const queryIndex = callCount++;
      const chain: Record<string, unknown> = {};

      if (queryIndex === 0) {
        // credentials lookup
        const rows = credentialExists
          ? [{ id: "cred-1", fingerprint }]
          : [];
        const p = Promise.resolve(rows);
        chain.from = () => chain;
        chain.where = () => chain;
        chain.limit = () => p;
        chain.then = p.then.bind(p);
        chain.catch = p.catch.bind(p);
      } else {
        // aggregate query
        const p = Promise.resolve([aggregateRow]);
        chain.from = () => chain;
        chain.where = () => p;
        chain.limit = () => p;
        chain.then = p.then.bind(p);
        chain.catch = p.catch.bind(p);
      }
      return chain;
    },
  };

  return db as unknown as Db;
}

// ---------------------------------------------------------------------------
// Sample token turn data
// ---------------------------------------------------------------------------

const sampleTurns = [
  {
    id: "t1",
    sessionId: "session-1",
    ts: new Date("2026-04-14T19:00:00Z"),
    model: "claude-sonnet-4-6",
    serviceTier: "standard",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 20,
    costUsd: "0.010935",
    credentialId: "cred-1",
    credentialFingerprint: "fp-1",
  },
  {
    id: "t2",
    sessionId: "session-1",
    ts: new Date("2026-04-14T19:01:00Z"),
    model: "claude-sonnet-4-6",
    serviceTier: "standard",
    inputTokens: 200,
    outputTokens: 75,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 50,
    costUsd: "0.001740",
    credentialId: "cred-1",
    credentialFingerprint: "fp-1",
  },
  {
    id: "t3",
    sessionId: "session-1",
    ts: new Date("2026-04-14T19:02:00Z"),
    model: "claude-opus-4-6",
    serviceTier: "standard",
    inputTokens: 500,
    outputTokens: 150,
    cacheCreationInputTokens: 25,
    cacheReadInputTokens: 100,
    costUsd: "0.019469",
    credentialId: "cred-1",
    credentialFingerprint: "fp-1",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /sessions/{id}/tokens", () => {
  it("returns turns array and aggregates for existing session", async () => {
    const db = mockDbForSessionTokens(true, sampleTurns);

    const response = await handleGetSessionTokens(db, "session-1");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      turns: typeof sampleTurns;
      aggregates: {
        input: number;
        output: number;
        cache_creation: number;
        cache_read: number;
        cost_usd: number | null;
        turn_count: number;
      };
    };

    // Verify turns
    expect(body.turns.length).toBe(3);

    // Verify aggregates
    expect(body.aggregates.turn_count).toBe(3);
    expect(body.aggregates.input).toBe(100 + 200 + 500); // 800
    expect(body.aggregates.output).toBe(50 + 75 + 150); // 275
    expect(body.aggregates.cache_creation).toBe(10 + 0 + 25); // 35
    expect(body.aggregates.cache_read).toBe(20 + 50 + 100); // 170

    // Cost should be the sum of all three turns
    expect(body.aggregates.cost_usd).not.toBeNull();
    const expectedCost = 0.010935 + 0.001740 + 0.019469;
    expect(body.aggregates.cost_usd).toBeCloseTo(expectedCost, 4);
  });

  it("returns 404 for non-existent session", async () => {
    const db = mockDbForSessionTokens(false, []);

    const response = await handleGetSessionTokens(db, "non-existent");
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("session not found");
  });

  it("returns empty turns and zero aggregates when session has no token data", async () => {
    const db = mockDbForSessionTokens(true, []);

    const response = await handleGetSessionTokens(db, "session-empty");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      turns: unknown[];
      aggregates: {
        input: number;
        output: number;
        cache_creation: number;
        cache_read: number;
        cost_usd: number | null;
        turn_count: number;
      };
    };

    expect(body.turns.length).toBe(0);
    expect(body.aggregates.turn_count).toBe(0);
    expect(body.aggregates.input).toBe(0);
    expect(body.aggregates.output).toBe(0);
    expect(body.aggregates.cache_creation).toBe(0);
    expect(body.aggregates.cache_read).toBe(0);
    // cost_usd starts at 0 accumulator but with 0 turns stays 0
    expect(body.aggregates.cost_usd).toBe(0);
  });
});

describe("GET /credentials/{id}/usage", () => {
  it("returns fingerprint-level rollup for valid window", async () => {
    const db = mockDbForCredentialUsage(true, "fp-1", {
      input: 800,
      output: 275,
      cache_creation: 35,
      cache_read: 170,
      cost_usd: "0.032144",
      turn_count: 3,
      session_count: 1,
    });

    const request = new Request("http://localhost:7400/credentials/cred-1/usage?window=24h");
    const response = await handleCredentialUsage(db, "cred-1", request);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      input: number;
      output: number;
      cache_creation: number;
      cache_read: number;
      cost_usd: number | null;
      turn_count: number;
      session_count: number;
    };

    expect(body.input).toBe(800);
    expect(body.output).toBe(275);
    expect(body.cache_creation).toBe(35);
    expect(body.cache_read).toBe(170);
    expect(body.cost_usd).toBeCloseTo(0.032144, 4);
    expect(body.turn_count).toBe(3);
    expect(body.session_count).toBe(1);
  });

  it("returns 400 for invalid window parameter", async () => {
    // handleCredentialUsage reads from the request URL, doesn't need DB for this case
    const db = {} as Db; // Won't be reached

    const request = new Request("http://localhost:7400/credentials/cred-1/usage?window=invalid");
    const response = await handleCredentialUsage(db, "cred-1", request);
    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: string;
      valid: string[];
    };

    expect(body.error).toBe("invalid window parameter");
    expect(body.valid).toContain("1h");
    expect(body.valid).toContain("6h");
    expect(body.valid).toContain("24h");
    expect(body.valid).toContain("7d");
  });

  it("returns 404 when credential is not found", async () => {
    const db = mockDbForCredentialUsage(false, "", {});

    const request = new Request("http://localhost:7400/credentials/missing/usage?window=24h");
    const response = await handleCredentialUsage(db, "missing", request);
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("credential not found");
  });

  it("accepts all valid window values", async () => {
    for (const window of ["1h", "6h", "24h", "7d"]) {
      const db = mockDbForCredentialUsage(true, "fp-test", {
        input: 0,
        output: 0,
        cache_creation: 0,
        cache_read: 0,
        cost_usd: null,
        turn_count: 0,
        session_count: 0,
      });

      const request = new Request(
        `http://localhost:7400/credentials/cred-1/usage?window=${window}`,
      );
      const response = await handleCredentialUsage(db, "cred-1", request);
      expect(response.status).toBe(200);
    }
  });
});
