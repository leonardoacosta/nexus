/**
 * Unit tests for the proactive-swap evaluator.
 *
 * Spec: openspec/changes/credential-proactive-swap (tasks 2.1 + 2.2)
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
}

/** Build a usage row from a remaining ratio (limit fixed at 100). */
function row(
  id: string,
  fingerprint: string,
  remaining: number,
  opts: { email?: string | null; resetAt?: Date | null } = {},
): Row {
  return {
    id,
    fingerprint,
    accountEmail: opts.email ?? `${id}@example.com`,
    used: Math.round((1 - remaining) * 100),
    limit: 100,
    resetAt: opts.resetAt ?? new Date("2030-01-01T00:00:00.000Z"),
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
    (async (id: string) => ({ parked: null, activated: { id } }));

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

  it("low active + two candidates → swaps into the max-headroom candidate", async () => {
    const rows = [
      row("a", "fp-a", 0.05), // active, 5%
      row("b", "fp-b", 0.4), // 40%
      row("c", "fp-c", 0.7), // 70% — winner
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["c"]);
    expect(h.audits.map((a) => a.event)).toEqual([
      "credential.auto_swap_out",
      "credential.auto_swap_in",
    ]);
    expect(h.audits[0]?.credential_id).toBe("a");
    expect(h.audits[1]?.credential_id).toBe("c");
    expect(h.audits[0]?.claimed_actor).toBe("auto-usage");
  });

  it("all other candidates at/below 10% → no swap (ladder branch)", async () => {
    const rows = [
      row("a", "fp-a", 0.05),
      row("b", "fp-b", 0.08), // ineligible
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual([]);
    expect(h.notifications.length).toBeGreaterThan(0); // ladder fired
  });

  it("recent swap within 30 min → skips swap entirely", async () => {
    const rows = [row("a", "fp-a", 0.05), row("c", "fp-c", 0.7)];
    const { opts, h } = makeOpts(rows, {
      activeFingerprint: "fp-a",
      now: new Date("2030-01-01T00:10:00.000Z"),
      lastSwapAt: new Date("2030-01-01T00:00:00.000Z"), // 10 min ago
    });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("cooldown error on the top candidate → falls through to the next", async () => {
    const rows = [
      row("a", "fp-a", 0.05),
      row("b", "fp-b", 0.4), // second choice
      row("c", "fp-c", 0.7), // first choice — cooldown
    ];
    const { opts, h } = makeOpts(rows, {
      activeFingerprint: "fp-a",
      manualSwap: async (id) => {
        if (id === "c") throw new Error("target credential is in cooldown");
        return { parked: null, activated: { id } };
      },
    });
    await evaluateProactiveSwap(opts);
    expect(h.swaps).toEqual(["c", "b"]);
    expect(h.audits[1]?.credential_id).toBe("b"); // swapped into the fallback
  });
});

describe("evaluateProactiveSwap — exhaustion ladder", () => {
  const soon = new Date("2030-01-01T05:00:00.000Z");

  it("crossing to 9% fires the 10% and 8% thresholds once (tts + desktop)", async () => {
    const rows = [
      row("a", "fp-a", 0.09, { email: "primary@example.com", resetAt: soon }),
    ];
    const { opts, h } = makeOpts(rows, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(opts);

    const channels = h.notifications.map((n) => n.channel).sort();
    expect(channels).toEqual(["desktop", "desktop", "tts", "tts"]); // 2 thresholds x 2 channels
    // Soonest-resetting account named in every body.
    for (const n of h.notifications) {
      expect(n.body).toContain("primary@example.com");
      expect(n.body).toContain(soon.toISOString());
    }

    // Steady at 9% → nothing further fires.
    h.notifications.length = 0;
    await evaluateProactiveSwap(opts);
    expect(h.notifications).toEqual([]);
  });

  it("a new 5h window (changed resetAt) re-arms the ladder", async () => {
    const first = [row("a", "fp-a", 0.09, { resetAt: soon })];
    const { opts: o1, h: h1 } = makeOpts(first, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(o1);
    expect(h1.notifications.length).toBe(4);

    // Same fingerprint, later window → re-arm and fire again.
    const later = new Date("2030-01-01T10:00:00.000Z");
    const second = [row("a", "fp-a", 0.09, { resetAt: later })];
    const { opts: o2, h: h2 } = makeOpts(second, { activeFingerprint: "fp-a" });
    await evaluateProactiveSwap(o2);
    expect(h2.notifications.length).toBe(4);
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
