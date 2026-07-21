/**
 * Unit tests for the shared credential-swap execution flow.
 *
 * Spec: openspec/changes/wire-reactive-rate-limit-swap (task 4.1)
 *
 * Covers the four side-effects `performCredentialSwap` chains (design.md /
 * the file-level doc comment on credential-swap-flow.ts):
 *   1. a `credential_swaps` row is written with the right fingerprints/reason
 *   2. the swap-tracker is stamped for BOTH the parked and activated fingerprint
 *   3. a `NotificationFired` envelope is emitted on both desktop and tts
 *   4. the 180s debounce window (isDebounced/armDebounce) is honored
 *
 * A fake `db` captures the `credential_swaps` insert; the swap-tracker is the
 * REAL module (reset via `__resetForTests` between tests) since asserting
 * against its own `lastSwapAt` reader is more faithful than mocking it away.
 * `audit` is stubbed via the injectable opt (its real implementation touches
 * `routes/credentials/shared.ts`'s own sink, out of scope here); `notify` is
 * captured via the same seam.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import type { Db } from "@nexus/db";
import type { CredentialPool } from "../credentials/pool";
import type { ManualSwapResult } from "../credentials/pool/types";
import {
  performCredentialSwap,
  isDebounced,
  armDebounce,
  __resetDebounceForTests,
} from "./credential-swap-flow";
import {
  lastSwapAt,
  __resetForTests as resetSwapTracker,
} from "./credential-pool/swap-tracker";
import type { NotificationFiredPayload } from "./lifecycle-bus";

function makeFakeDb(): { db: Db; inserted: Record<string, unknown>[] } {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
      },
    }),
  } as unknown as Db;
  return { db, inserted };
}

function makePool(
  result: ManualSwapResult | null,
): Pick<CredentialPool, "manualSwap"> {
  return { manualSwap: async () => result };
}

function makeManualSwapResult(): ManualSwapResult {
  return {
    parked: { id: "cred-1", fingerprint: "fp-old", accountName: "Old Account" },
    activated: { id: "cred-2", fingerprint: "fp-new", accountName: "New Account" },
  } as unknown as ManualSwapResult;
}

describe("performCredentialSwap", () => {
  beforeEach(() => {
    resetSwapTracker();
    __resetDebounceForTests();
  });

  it("writes a credential_swaps row and stamps the swap-tracker for both fingerprints", async () => {
    const { db, inserted } = makeFakeDb();
    const pool = makePool(makeManualSwapResult());

    const outcome = await performCredentialSwap({
      db,
      pool,
      targetId: "cred-2",
      reason: "reactive",
      sessionId: "sess-1",
      audit: () => {},
      notify: () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      sessionId: "sess-1",
      fromFingerprint: "fp-old",
      toFingerprint: "fp-new",
      reason: "reactive",
    });

    expect(lastSwapAt("fp-old")).not.toBeNull();
    expect(lastSwapAt("fp-new")).not.toBeNull();
  });

  it("defaults sessionId to 'system' when the caller omits it (proactive trigger)", async () => {
    const { db, inserted } = makeFakeDb();
    const pool = makePool(makeManualSwapResult());

    await performCredentialSwap({
      db,
      pool,
      targetId: "cred-2",
      reason: "proactive",
      audit: () => {},
      notify: () => {},
    });

    expect(inserted[0]).toMatchObject({ sessionId: "system", reason: "proactive" });
  });

  it("emits a NotificationFired envelope on both the desktop and tts channels", async () => {
    const { db } = makeFakeDb();
    const pool = makePool(makeManualSwapResult());
    const notified: NotificationFiredPayload[] = [];

    await performCredentialSwap({
      db,
      pool,
      targetId: "cred-2",
      reason: "reactive",
      sessionId: "sess-1",
      audit: () => {},
      notify: (p) => notified.push(p),
    });

    expect(notified).toHaveLength(2);
    const channels = notified.map((n) => n.channel).sort();
    expect(channels).toEqual(["desktop", "tts"]);
    for (const n of notified) {
      expect(n.body).toContain("Old Account");
      expect(n.body).toContain("New Account");
    }
  });

  it("is a no-op (ok:false) when the target credential does not exist — no insert, no notify", async () => {
    const { db, inserted } = makeFakeDb();
    const pool = makePool(null);
    const notified: NotificationFiredPayload[] = [];

    const outcome = await performCredentialSwap({
      db,
      pool,
      targetId: "missing",
      reason: "reactive",
      audit: () => {},
      notify: (p) => notified.push(p),
    });

    expect(outcome).toEqual({ ok: false, result: null });
    expect(inserted).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
});

describe("isDebounced / armDebounce (180s reactive-swap debounce window)", () => {
  beforeEach(() => __resetDebounceForTests());

  it("a session with no prior reactive swap is not debounced", () => {
    expect(isDebounced("sess-fresh")).toBe(false);
  });

  it("arming starts a 180s window; still debounced just before expiry", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    armDebounce("sess-a", t0);
    expect(isDebounced("sess-a", new Date(t0.getTime() + 179_000))).toBe(true);
  });

  it("the window expires at exactly 180s", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    armDebounce("sess-a", t0);
    expect(isDebounced("sess-a", new Date(t0.getTime() + 180_000))).toBe(false);
  });

  it("tracks sessions independently — arming one does not debounce another", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    armDebounce("sess-a", t0);
    expect(isDebounced("sess-b", t0)).toBe(false);
  });
});
