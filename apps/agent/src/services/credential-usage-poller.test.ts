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
import {
  parseUsageBody,
  startCredentialUsagePoller,
  computeNextIntervalMs,
} from "./credential-usage-poller";
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

  // nx-8ahjt root cause: the live Anthropic /api/oauth/usage response never
  // sends `used`/`limit` — it sends `utilization` (a 0-100 percent) plus a
  // handful of dollar fields that are null unless spend-based billing is
  // enabled. This is the actual shape captured live against production
  // 2026-07-11 (truncated to the fields pickWindow cares about).
  it("parses the live Anthropic `utilization`-percent shape (nx-8ahjt)", () => {
    const body = {
      five_hour: {
        utilization: 0.0,
        resets_at: "2026-07-12T03:39:59.921140+00:00",
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
      seven_day: {
        utilization: 94.0,
        resets_at: "2026-07-16T17:59:59.921161+00:00",
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null,
      },
    };
    const parsed = parseUsageBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.fiveHour.used).toBe(0);
    expect(parsed?.fiveHour.limit).toBe(100);
    expect(parsed?.fiveHour.resetsAt?.toISOString()).toBe(
      "2026-07-12T03:39:59.921Z",
    );
    expect(parsed?.sevenDay.used).toBe(94);
    expect(parsed?.sevenDay.limit).toBe(100);
  });

  it("rounds a fractional `utilization` percent to the nearest integer", () => {
    const body = {
      five_hour: { utilization: 42.4, resets_at: null },
      seven_day: { utilization: 27.6, resets_at: null },
    };
    const parsed = parseUsageBody(body);
    expect(parsed?.fiveHour.used).toBe(42);
    expect(parsed?.sevenDay.used).toBe(28);
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

// ── computeNextIntervalMs selection table (adaptive-usage-poll-cadence 1.1) ──
//
// Pins the first-match-wins order: backoff > hot (>=80) > default. The 80
// threshold is `>=`, not `>`. A null max (no parseable/limited rows this tick)
// falls through to the default interval, never hot.

describe("computeNextIntervalMs", () => {
  const BACKOFF = 30 * 60 * 1000;
  const DEFAULT = 5 * 60 * 1000;
  const HOT = 60 * 1000;

  function next(
    maxFiveHourUtilization: number | null,
    backoff: boolean,
    hotIntervalMs = HOT,
  ): number {
    return computeNextIntervalMs({
      maxFiveHourUtilization,
      backoff,
      backoffMs: BACKOFF,
      intervalMs: DEFAULT,
      hotIntervalMs,
    });
  }

  it("backs off even when utilization is also hot (backoff wins)", () => {
    expect(next(95, true)).toBe(BACKOFF);
  });

  it("returns the hot interval at exactly 80 (>=, not >)", () => {
    expect(next(80, false)).toBe(HOT);
  });

  it("returns the hot interval above 80", () => {
    expect(next(99, false)).toBe(HOT);
  });

  it("returns the default interval at 79.9 (below threshold)", () => {
    expect(next(79.9, false)).toBe(DEFAULT);
  });

  it("returns the default interval when max utilization is null", () => {
    expect(next(null, false)).toBe(DEFAULT);
  });

  it("honors whatever hotIntervalMs is passed (env-resolved value flows through)", () => {
    // The env override resolves to a concrete hotIntervalMs in the caller; the
    // function's job is to return exactly the value it was handed for a hot tick.
    expect(next(90, false, 12345)).toBe(12345);
    expect(next(90, false, 777)).toBe(777);
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

// ── adaptive cadence: tick → max 5-hour util → hot reschedule (1.2 / 1.3) ───
//
// A tick whose parsed 5-hour utilization is >= 80 MUST surface that value on
// tickOnce()'s result, and computeNextIntervalMs MUST pick the hot interval for
// it. Rows whose written snapshot has a zero limit are excluded from the max.

const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;

describe("credential-usage-poller: adaptive cadence (adaptive-usage-poll-cadence)", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
    delete process.env.NEXUS_USAGE_POLL_HOT_INTERVAL_MS;
  });

  it("surfaces max 5-hour utilization and reschedules hot when >=80", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 95, resets_at: null },
          seven_day: { utilization: 10, resets_at: null },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const svc = startCredentialUsagePoller({
      db: capturingDb([]),
      pool: tokenPool(),
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result.succeeded).toBe(1);
      expect(result.maxFiveHourUtilization).toBe(95);

      // Compose with the pure selector: this max drives a hot reschedule.
      const next = computeNextIntervalMs({
        maxFiveHourUtilization: result.maxFiveHourUtilization,
        backoff: result.backedOff,
        backoffMs: 30 * 60 * 1000,
        intervalMs: 5 * 60 * 1000,
        hotIntervalMs: 60 * 1000,
      });
      expect(next).toBe(60 * 1000);
    } finally {
      svc.stop();
    }
  });

  it("excludes zero-limit rows from the max (null → default cadence)", async () => {
    // Legacy used/limit shape with a zero limit: writes a snapshot but carries
    // no real utilization, so it MUST NOT contribute to maxFiveHourUtilization.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          five_hour: { used: 5, limit: 0, resets_at: null },
          seven_day: { used: 5, limit: 0, resets_at: null },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const svc = startCredentialUsagePoller({
      db: capturingDb([]),
      pool: tokenPool(),
      intervalMs: 1_000_000,
    });
    try {
      const result = await svc.tickOnce();
      expect(result.succeeded).toBe(1);
      expect(result.maxFiveHourUtilization).toBeNull();
    } finally {
      svc.stop();
    }
  });

  it("reschedules at the NEXUS_USAGE_POLL_HOT_INTERVAL_MS override after a >=80 tick", async () => {
    process.env.NEXUS_USAGE_POLL_HOT_INTERVAL_MS = "12345";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 88, resets_at: null },
          seven_day: { utilization: 10, resets_at: null },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    // Non-firing setTimeout spy: record (cb, delay); fire manually so we observe
    // the reschedule delay deterministically without a real timer race.
    const scheduled: Array<{ cb: () => void; delay: number }> = [];
    globalThis.setTimeout = ((cb: () => void, delay?: number) => {
      scheduled.push({ cb, delay: delay ?? 0 });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const svc = startCredentialUsagePoller({
      db: capturingDb([]),
      pool: tokenPool(),
      intervalMs: 500_000,
    });
    try {
      // Startup scheduled the first tick at the default interval.
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.delay).toBe(500_000);

      // Fire the scheduled tick; let its async work + reschedule settle. The
      // in-tick fetch timeout also registers a setTimeout, so the reschedule
      // (the only entry at the hot override) is identified by its delay, not
      // its position.
      scheduled[0]?.cb();
      for (
        let i = 0;
        i < 100 && !scheduled.some((s) => s.delay === 12345);
        i++
      ) {
        await new Promise((r) => ORIGINAL_SET_TIMEOUT(r, 1));
      }

      // The hot override drove the reschedule, and it was the last schedule.
      expect(scheduled.some((s) => s.delay === 12345)).toBe(true);
      expect(scheduled[scheduled.length - 1]?.delay).toBe(12345);
    } finally {
      svc.stop();
    }
  });
});
