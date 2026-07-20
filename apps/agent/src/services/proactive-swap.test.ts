/**
 * Unit tests for the proactive-swap evaluator.
 *
 * Spec: openspec/changes/credential-proactive-swap (tasks 2.1 + 2.2),
 * retuned by openspec/changes/wire-reactive-rate-limit-swap (task 2.6 —
 * squeeze-dry: REMAINING_THRESHOLD 0.10 -> 0.02, effective remaining across
 * BOTH the 5h and 7d windows, ANTI_FLAP_MS 30 -> 10 min).
 *
 * Pure-logic coverage — no Postgres. The DB is a thin builder stub returning a
 * fixed row set; the pool, swap-tracker, notify sink, and audit sink are all
 * injected fakes so every branch is asserted deterministically.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import type { Db } from "@nexus/db";
import {
  evaluateProactiveSwap,
  __resetLadderStateForTests,
  type EvaluateProactiveSwapOpts,
} from "./proactive-swap";
import type { NotificationFiredPayload } from "./lifecycle-bus";
import type { CredentialAuditEntry } from "../routes/credentials/shared";

interface Row {
  id: string;
  fingerprint: string;
  accountEmail: string | null;
  used: number | null;
  limit: number | null;
  resetAt: Date | null;
  used7d: number | null;
  limit7d: number | null;
}

/**
 * Build a usage row from a 5h remaining ratio (limit fixed at 100). 7d
 * defaults to healthy (remaining7d=1) so existing 5h-only scenarios are
 * unaffected by the effective-remaining = min(5h, 7d) extension unless a
 * test explicitly overrides `remaining7d`.
 */
function row(
  id: string,
  fingerprint: string,
  remaining: number,
  opts: {
    email?: string | null;
    resetAt?: Date | null;
    remaining7d?: number;
  } = {},
): Row {
  const remaining7d = opts.remaining7d ?? 1;
  return {
    id,
    fingerprint,
    accountEmail: opts.email ?? `${id}@example.com`,
    used: Math.round((1 - remaining) * 100),
    limit: 100,
    resetAt: opts.resetAt ?? new Date("2030-01-01T00:00:00.000Z"),
    used7d: Math.round((1 - remaining7d) * 100),
    limit7d: 100,
  };
}

/** Minimal drizzle-chain stub: `select().from().where()` resolves to `rows`. */
function fakeDb(rows: Row[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve(undefined),
    }),
  } as unknown as Db;
}

interface Harness {
  swaps: string[];
  notifications: NotificationFiredPayload[];
  audits: CredentialAuditEntry[];
}

function makeOpts(
  rows: Row[],
  overrides: {
    activeFingerprint: string;
    lastSwapAt?: Date | null;
    manualSwap?: (id: string) => Promise<unknown>;
    now?: Date;
  },
): { opts: EvaluateProactiveSwapOpts; h: Harness } {
  const h: Harness = { swaps: [], notifications: [], audits: [] };
  const manualSwap =
    overrides.manualSwap ??
    (async (id: string) => ({ parked: null, activated: { id, fingerprint: id } }));

  const opts: EvaluateProactiveSwapOpts = {
    db: fakeDb(rows),
    pool: {
      manualSwap: async (id: string) => {
        h.swaps.push(id);
        return (await manualSwap(id)) as never;
      },
    },
    swapTracker: { lastSwapAt: () => overrides.lastSwapAt ?? null },
    now: () => overrides.now ?? new Date("2030-01-01T00:00:00.000Z"),
    activeFingerprint: () => overrides.activeFingerprint,
    notify: (p) => h.notifications.push(p),
    audit: (e) => h.audits.push(e),
  };
  return { opts, h };
}

beforeEach(() => __resetLadderStateForTests());

describe("evaluateProactiveSwap — swap branch", () => {
  it("healthy active credential → no swap, no notification", async () => {
    const rows = [row("a", "fp-a", 0.5), row("b", "fp-b", 0.9)];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("low active (≤2%) + two candidates → swaps into the max-headroom candidate", async () => {
    const rows = [
      row("a", "fp-a", 0.01), // active, 1% — below the 2% squeeze-dry line
      row("b", "fp-b", 0.4), // 40%
      row("c", "fp-c", 0.7), // 70% — winner
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["c"]);
    expect(h.audits.map((a) => a.event)).toEqual([
      "credential.auto_swap_in",
    ]);
    expect(h.audits[0]?.credential_id).toBe("c");
    expect(h.audits[0]?.claimed_actor).toBe("auto-usage");
  });

  it("5h healthy but 7d exhausted → effective remaining (min of both windows) still triggers", async () => {
    const rows = [
      row("a", "fp-a", 0.9, { remaining7d: 0.01 }), // 5h fine, 7d exhausted
      row("b", "fp-b", 0.5, { remaining7d: 0.5 }),
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["b"]);
  });

  it("eligible candidate present → swap taken, ladder suppressed (only the swap notification fires)", async () => {
    // 2.2: when a swap target is available the ladder MUST NOT fire — the
    // graduated exhaustion notification is only for the no-candidate case.
    // A successful swap DOES fire its own "swapped <from> → <to>"
    // notification (credential-swap-flow.ts) — that is new, expected
    // behavior (proposal.md § Done Means), distinct from the ladder.
    const rows = [row("a", "fp-a", 0.01), row("c", "fp-c", 0.7)];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["c"]);
    expect(h.notifications.every((n) => n.id.startsWith("credential-swap-"))).toBe(true);
    expect(h.notifications.some((n) => n.id.startsWith("proactive-swap-ladder-"))).toBe(false);
  });

  it("all other candidates at/below 2% → no swap (ladder branch)", async () => {
    const rows = [
      row("a", "fp-a", 0.01),
      row("b", "fp-b", 0.02), // ineligible — exactly at the threshold
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual([]);
    expect(h.notifications.length).toBeGreaterThan(0); // ladder fired
  });

  it("recent swap within 10 min → skips swap entirely", async () => {
    const rows = [row("a", "fp-a", 0.01), row("c", "fp-c", 0.7)];
    const { opts, h } = makeOpts(rows, {
      activeFingerprint: "fp-a",
      now: new Date("2030-01-01T00:05:00.000Z"),
      lastSwapAt: new Date("2030-01-01T00:00:00.000Z"), // 5 min ago
    });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("swap 11 min after the last one → anti-flap window has expired, proceeds", async () => {
    const rows = [row("a", "fp-a", 0.01), row("c", "fp-c", 0.7)];
    const { opts, h } = makeOpts(rows, {
      activeFingerprint: "fp-a",
      now: new Date("2030-01-01T00:11:00.000Z"),
      lastSwapAt: new Date("2030-01-01T00:00:00.000Z"), // 11 min ago
    });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["c"]);
  });

  it("cooldown error on the top candidate → falls through to the next", async () => {
    const rows = [
      row("a", "fp-a", 0.01),
      row("b", "fp-b", 0.4), // second choice
      row("c", "fp-c", 0.7), // first choice — cooldown
    ];
    const { opts, h } = makeOpts(rows, {
      activeFingerprint: "fp-a",
      manualSwap: async (id) => {
        if (id === "c") throw new Error("target credential is in cooldown");
        return { parked: null, activated: { id, fingerprint: id } };
      },
    });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["c", "b"]);
    expect(h.audits[0]?.credential_id).toBe("b"); // swapped into the fallback
  });
});

describe("evaluateProactiveSwap — exhaustion ladder", () => {
  const soon = new Date("2030-01-01T05:00:00.000Z");

  it("at/below 2% with no candidate fires the full ladder once (tts + desktop)", async () => {
    // Under the 2%-line trigger, the first evaluation to ever reach the
    // ladder has already crossed every rung above it (10/8/4/2) plus the
    // approaching 0% — so it fires all 5 thresholds x 2 channels in one
    // shot rather than a graduated 10%→8%→... sequence (design.md Decision
    // 5: the swap trigger and the ladder now share one tightened gate).
    const rows = [
      row("a", "fp-a", 0.01, { email: "primary@example.com", resetAt: soon }),
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);

    expect(h.notifications.length).toBe(10); // 5 thresholds x 2 channels
    const channels = new Set(h.notifications.map((n) => n.channel));
    expect(channels).toEqual(new Set(["desktop", "tts"]));
    for (const n of h.notifications) {
      expect(n.body).toContain("primary@example.com");
      expect(n.body).toContain(soon.toISOString());
    }

    // Steady at 1% → nothing further fires (already-fired thresholds are deduped).
    h.notifications.length = 0;
    await evaluateProactiveSwap(opts);
    expect(h.notifications).toEqual([]);
  });

  it("a new 5h window (changed resetAt) re-arms the ladder", async () => {
    const first = [row("a", "fp-a", 0.01, { resetAt: soon })];
    const { opts: o1, h: h1 } = makeOpts(first, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(o1);
    expect(h1.notifications.length).toBe(10);

    // Same fingerprint, later window → re-arm and fire again.
    const later = new Date("2030-01-01T10:00:00.000Z");
    const second = [row("a", "fp-a", 0.01, { resetAt: later })];
    const { opts: o2, h: h2 } = makeOpts(second, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(o2);
    expect(h2.notifications.length).toBe(10);
  });

  it("0% remaining fires the final (0%) threshold", async () => {
    const rows = [row("a", "fp-a", 0, { resetAt: soon })];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    // Fresh window at 0% fires the whole ladder incl 0%.
    const bodies = h.notifications.map((n) => n.body).join("\n");
    expect(bodies).toContain("at 0%");
  });
});
