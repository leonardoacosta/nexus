/**
 * Rules-engine tests (openspec/changes/context-aware-routing).
 *
 * Covers first-match-wins, Rule 1 (active Mac, incl. active-at-night beating
 * bedtime), Rule 2 (meeting-hold with the 60m cap + 2m buffer), the terminal
 * fallback, the staleness policy, and flag-off legacy parity.
 */

import { describe, expect, it, mock } from "bun:test";
import * as coreNode from "@nexus/core/node";
import type { PresenceVector, PresenceField } from "@nexus/core";

const loggerMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  fatal: mock(() => {}),
  child: () => loggerMock,
};

mock.module("@nexus/core/node", () => ({
  ...coreNode,
  logger: loggerMock,
  createLogger: () => loggerMock,
}));

import { evaluateRules, isVectorAllUnknown } from "./rules-engine";
import { decidePresenceRoute, actionToChannels } from "./router";
import { applyBedtimeSources } from "./presence-context";

// ── Vector builders ───────────────────────────────────────────────────────

function field<T>(value: T | null, confidence: "high" | "unknown" = "high"): PresenceField<T> {
  return {
    value,
    source: "test",
    updatedAt: new Date().toISOString(),
    confidence: value === null ? "unknown" : confidence,
  };
}

function vector(overrides: Partial<{
  macActive: boolean | null;
  macLocked: boolean | null;
  macHost: string | null;
  inMeeting: boolean | null;
  meetingEndsAt: string | null;
  isBedtime: boolean | null;
  phonePresent: boolean | null;
  phoneHome: boolean | null;
  macIdleSec: number | null;
  macFocus: string | null;
  phoneFocusOn: boolean | null;
}> = {}): PresenceVector {
  return {
    userId: "leo",
    macActive: field(overrides.macActive ?? null),
    macLocked: field(overrides.macLocked ?? null),
    macHost: field(overrides.macHost ?? null),
    inMeeting: field(overrides.inMeeting ?? null),
    meetingEndsAt: field(overrides.meetingEndsAt ?? null),
    isBedtime: field(overrides.isBedtime ?? null),
    phonePresent: field(overrides.phonePresent ?? null),
    phoneHome: field(overrides.phoneHome ?? null),
    macIdleSec: field(overrides.macIdleSec ?? null),
    macFocus: field(overrides.macFocus ?? null),
    phoneFocusOn: field(overrides.phoneFocusOn ?? null),
  };
}

describe("rules-engine — Rule 1 (active Mac, not in meeting)", () => {
  it("active Mac, not in meeting → banner + tts to macHost", () => {
    const action = evaluateRules(
      vector({ macActive: true, macHost: "studio", inMeeting: false }),
    );
    expect(action.banner).toBe(true);
    expect(action.tts).toBe(true);
    expect(action.deliverTo).toEqual(["mac"]);
    expect(action.holdUntil).toBeNull();
  });

  it("active Mac at night STILL speaks — beats bedtime (Q1)", () => {
    const action = evaluateRules(
      vector({
        macActive: true,
        macHost: "studio",
        inMeeting: false,
        isBedtime: true,
      }),
    );
    expect(action.banner).toBe(true);
    expect(action.tts).toBe(true);
    expect(action.digest).toBe(false);
  });
});

describe("rules-engine — first-match-wins", () => {
  it("active Mac wins over the meeting rule when both could match", () => {
    // macActive true AND inMeeting true — Rule 1 requires NOT inMeeting, so
    // Rule 2 should win (hold). This asserts the ORDER: Rule 1's guard is
    // checked first and rejected, Rule 2 matches.
    const action = evaluateRules(
      vector({ macActive: true, macHost: "studio", inMeeting: true }),
    );
    expect(action.holdUntil).not.toBeNull();
    expect(action.digest).toBe(true);
  });
});

describe("rules-engine — Rule 2 (in meeting → hold)", () => {
  it("holds until meetingEndsAt + 2m buffer", () => {
    const endsAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const action = evaluateRules(
      vector({ macActive: true, inMeeting: true, meetingEndsAt: endsAt }),
    );
    expect(action.digest).toBe(true);
    expect(action.holdUntil).not.toBeNull();
    const hold = new Date(action.holdUntil!).getTime();
    const expected = new Date(endsAt).getTime() + 2 * 60_000;
    expect(Math.abs(hold - expected)).toBeLessThan(1_000);
  });

  it("caps holdUntil at now + 60m + 2m when meetingEndsAt is unknown", () => {
    const before = Date.now();
    const action = evaluateRules(
      vector({ macActive: true, inMeeting: true, meetingEndsAt: null }),
    );
    expect(action.holdUntil).not.toBeNull();
    const hold = new Date(action.holdUntil!).getTime();
    const expectedMin = before + (60 + 2) * 60_000;
    expect(hold).toBeGreaterThanOrEqual(expectedMin - 1_000);
    expect(hold).toBeLessThanOrEqual(Date.now() + (60 + 2) * 60_000 + 1_000);
  });
});

describe("rules-engine — Rule 4 (idle/locked Mac + phone home → room-TTS)", () => {
  it("locked Mac + phone present & home → tts to macHost", () => {
    const action = evaluateRules(
      vector({
        macLocked: true,
        macHost: "studio",
        phonePresent: true,
        phoneHome: true,
      }),
    );
    expect(action.tts).toBe(true);
    expect(action.deliverTo).toEqual(["mac"]);
    expect(action.banner).toBe(false);
    expect(action.digest).toBe(false);
  });

  it("idle Mac (macActive false) + phone home → tts to macHost", () => {
    const action = evaluateRules(
      vector({
        macActive: false,
        macHost: "studio",
        phonePresent: true,
        phoneHome: true,
      }),
    );
    expect(action.tts).toBe(true);
    expect(action.deliverTo).toEqual(["mac"]);
  });

  it("phone away (phoneHome false) → Rule 4 does NOT fire, falls through to terminal", () => {
    const action = evaluateRules(
      vector({
        macLocked: true,
        macHost: "studio",
        phonePresent: true,
        phoneHome: false,
      }),
    );
    expect(action.tts).toBe(false);
    expect(action.deliverTo).toEqual(["dashboard"]);
    expect(action.digest).toBe(true);
  });

  it("phone not present → Rule 4 does NOT fire", () => {
    const action = evaluateRules(
      vector({
        macLocked: true,
        macHost: "studio",
        phonePresent: false,
        phoneHome: true,
      }),
    );
    expect(action.tts).toBe(false);
    expect(action.deliverTo).toEqual(["dashboard"]);
  });

  it("unknown phoneHome → fail-safe (no room-TTS, terminal digest)", () => {
    // Stale Tailscale poll leaves phoneHome unknown. Rule 4 MUST NOT speak into
    // the room on indeterminate home state — non-critical fail-safe.
    const action = evaluateRules(
      vector({
        macLocked: true,
        macHost: "studio",
        phonePresent: true,
        phoneHome: null,
      }),
    );
    expect(action.tts).toBe(false);
    expect(action.deliverTo).toEqual(["dashboard"]);
    expect(action.digest).toBe(true);
  });

  it("active Mac (not idle/locked) + phone home → Rule 1 wins, NOT Rule 4", () => {
    // An active, unlocked Mac that is not in a meeting takes Rule 1 (banner+tts
    // to the desk) — Rule 4 only applies when the Mac is idle or locked.
    const action = evaluateRules(
      vector({
        macActive: true,
        macLocked: false,
        macHost: "studio",
        inMeeting: false,
        phonePresent: true,
        phoneHome: true,
      }),
    );
    expect(action.banner).toBe(true);
    expect(action.tts).toBe(true);
    // Rule 1 redacts titlesOnly + banner; Rule 4 has banner false — banner proves Rule 1.
  });

  it("meeting hold beats Rule 4 — ordering after Rule 2", () => {
    // Mac present + in meeting must HOLD (Rule 2) even if the phone is home,
    // proving Rule 4 evaluates AFTER Rule 2.
    const action = evaluateRules(
      vector({
        macLocked: true,
        macHost: "studio",
        inMeeting: true,
        phonePresent: true,
        phoneHome: true,
      }),
    );
    expect(action.holdUntil).not.toBeNull();
    expect(action.digest).toBe(true);
  });
});

describe("rules-engine — terminal fallback", () => {
  it("all-unknown vector → deliverTo dashboard + digest, never dropped", () => {
    const action = evaluateRules(vector());
    expect(action.deliverTo).toEqual(["dashboard"]);
    expect(action.digest).toBe(true);
    // Never a silent drop — at minimum the dashboard tray gets it.
    expect(action.deliverTo.length).toBeGreaterThan(0);
  });
});

describe("router — flag-off legacy parity", () => {
  it("decidePresenceRoute returns null when presence_aware_routing is false", () => {
    // The null signal forces the caller down the byte-identical legacy
    // routeNotificationParallel path — the engine is NOT consulted at all.
    const decision = decidePresenceRoute(
      false,
      vector({ macActive: true, macHost: "studio", inMeeting: false }),
    );
    expect(decision).toBeNull();
  });

  it("decidePresenceRoute consults the engine when the flag is on", () => {
    const decision = decidePresenceRoute(
      true,
      vector({ macActive: true, macHost: "studio", inMeeting: false }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.channels).toEqual(["desktop", "tts"]);
    expect(decision!.hold).toBe(false);
  });

  it("maps a meeting-hold action to hold=true with no immediate channels", () => {
    const decision = decidePresenceRoute(
      true,
      vector({ macActive: true, inMeeting: true, meetingEndsAt: null }),
    );
    expect(decision!.hold).toBe(true);
    expect(decision!.holdUntil).not.toBeNull();
    expect(decision!.channels).toEqual([]);
  });
});

describe("router — actionToChannels", () => {
  it("maps banner→desktop and tts→tts", () => {
    expect(
      actionToChannels({
        banner: true,
        ding: false,
        tts: true,
        deliverTo: ["mac"],
        deliveryMode: "simultaneous",
        interruptionLevel: "active",
        collapseId: "",
        stopPropagation: false,
        holdUntil: null,
        digest: false,
        redact: "full",
      }),
    ).toEqual(["desktop", "tts"]);
  });
});

describe("rules-engine — isVectorAllUnknown (headless-agent guard)", () => {
  it("all-unknown vector → true", () => {
    expect(isVectorAllUnknown(vector())).toBe(true);
  });

  it("any single known field → false (macActive)", () => {
    expect(isVectorAllUnknown(vector({ macActive: false }))).toBe(false);
  });

  it("any single known field → false (macHost)", () => {
    expect(isVectorAllUnknown(vector({ macHost: "studio" }))).toBe(false);
  });
});

describe("rules-engine — staleness policy", () => {
  it("non-critical with unknown rule-relevant field fails safe (digest, no tts)", () => {
    // macActive unknown means Rule 1 cannot fire; no meeting; falls through to
    // terminal fallback which is the fail-safe (digest) outcome.
    const action = evaluateRules(
      vector({ macActive: null, macHost: "studio" }),
    );
    expect(action.tts).toBe(false);
    expect(action.digest).toBe(true);
  });
});

// ── Phase 2 (ios-presence-reporter) ─────────────────────────────────────────

describe("rules-engine — Rule 3 (bedtime + idle Mac → silent passive phone)", () => {
  it("isBedtime true + macActive false → silent passive banner to phone", () => {
    const action = evaluateRules(
      vector({ isBedtime: true, macActive: false, macHost: "studio" }),
    );
    expect(action.banner).toBe(true);
    expect(action.ding).toBe(false);
    expect(action.tts).toBe(false);
    expect(action.deliverTo).toEqual(["phone"]);
    expect(action.interruptionLevel).toBe("passive");
  });

  it("active Mac beats bedtime — Rule 1 wins, Rule 3 does not fire (Q1)", () => {
    // macActive true (not in meeting) → Rule 1, even with isBedtime true.
    const action = evaluateRules(
      vector({
        isBedtime: true,
        macActive: true,
        macHost: "studio",
        inMeeting: false,
      }),
    );
    expect(action.tts).toBe(true); // Rule 1 speaks
    expect(action.deliverTo).toEqual(["mac"]);
  });

  it("meeting hold (Rule 2) beats Rule 3 — ordering after Rule 2", () => {
    // Mac present + in meeting + bedtime → Rule 2 HOLD wins (Rule 3 is after).
    const action = evaluateRules(
      vector({
        isBedtime: true,
        macActive: false,
        macLocked: true,
        macHost: "studio",
        inMeeting: true,
      }),
    );
    expect(action.holdUntil).not.toBeNull();
    expect(action.digest).toBe(true);
    expect(action.deliverTo).toEqual(["mac"]);
  });

  it("Rule 3 fires BEFORE Rule 4 — bedtime+idle+phone-home prefers silent phone", () => {
    // Both Rule 3 (bedtime+idle) and Rule 4 (idle+phone-home) could match; Rule
    // 3 is inserted first, so the silent phone banner wins over room-TTS.
    const action = evaluateRules(
      vector({
        isBedtime: true,
        macActive: false,
        macHost: "studio",
        phonePresent: true,
        phoneHome: true,
      }),
    );
    expect(action.deliverTo).toEqual(["phone"]);
    expect(action.tts).toBe(false);
  });

  it("isBedtime unknown → Rule 3 does NOT fire (fail-safe), falls through", () => {
    // macActive false + isBedtime unknown: Rule 3 guard fails. With no phone
    // home, falls through to the terminal digest.
    const action = evaluateRules(
      vector({ isBedtime: null, macActive: false, macHost: "studio" }),
    );
    expect(action.deliverTo).toEqual(["dashboard"]);
    expect(action.digest).toBe(true);
  });

  it("bedtime but macActive unknown → Rule 3 does NOT fire (needs known-false)", () => {
    const action = evaluateRules(
      vector({ isBedtime: true, macActive: null, macHost: "studio" }),
    );
    expect(action.deliverTo).not.toEqual(["phone"]);
  });
});

describe("rules-engine — Focus-respect modifier", () => {
  it("phoneFocusOn true drops a non-critical action's interruption to passive", () => {
    // Rule 1 (active Mac) normally emits interruptionLevel "active"; with a
    // Focus on, it drops to passive — channels (banner/tts) unchanged.
    const action = evaluateRules(
      vector({
        macActive: true,
        macHost: "studio",
        inMeeting: false,
        phoneFocusOn: true,
      }),
    );
    expect(action.interruptionLevel).toBe("passive");
    // Channels unchanged — Focus respect only lowers the interruption level.
    expect(action.banner).toBe(true);
    expect(action.tts).toBe(true);
    expect(action.deliverTo).toEqual(["mac"]);
  });

  it("phoneFocusOn false leaves the interruption level untouched", () => {
    const action = evaluateRules(
      vector({
        macActive: true,
        macHost: "studio",
        inMeeting: false,
        phoneFocusOn: false,
      }),
    );
    expect(action.interruptionLevel).toBe("active");
  });

  it("phoneFocusOn unknown leaves the interruption level untouched (fail-open)", () => {
    const action = evaluateRules(
      vector({
        macActive: true,
        macHost: "studio",
        inMeeting: false,
        phoneFocusOn: null,
      }),
    );
    expect(action.interruptionLevel).toBe("active");
  });
});

describe("applyBedtimeSources — truth table", () => {
  const T = { hkSleepWindow: true, sleepFocusActive: true };
  const F = { hkSleepWindow: false, sleepFocusActive: false };
  const HK = { hkSleepWindow: true, sleepFocusActive: false };
  const FOCUS = { hkSleepWindow: false, sleepFocusActive: true };

  it("hk → follows the HK window only", () => {
    expect(applyBedtimeSources("hk", HK)).toBe(true);
    expect(applyBedtimeSources("hk", FOCUS)).toBe(false);
    expect(applyBedtimeSources("hk", T)).toBe(true);
    expect(applyBedtimeSources("hk", F)).toBe(false);
  });

  it("focus → follows the Sleep-Focus signal only", () => {
    expect(applyBedtimeSources("focus", FOCUS)).toBe(true);
    expect(applyBedtimeSources("focus", HK)).toBe(false);
    expect(applyBedtimeSources("focus", T)).toBe(true);
    expect(applyBedtimeSources("focus", F)).toBe(false);
  });

  it("either → bedtime when EITHER source is active", () => {
    expect(applyBedtimeSources("either", HK)).toBe(true);
    expect(applyBedtimeSources("either", FOCUS)).toBe(true);
    expect(applyBedtimeSources("either", T)).toBe(true);
    expect(applyBedtimeSources("either", F)).toBe(false);
  });

  it("both → bedtime only when BOTH sources are active", () => {
    expect(applyBedtimeSources("both", T)).toBe(true);
    expect(applyBedtimeSources("both", HK)).toBe(false);
    expect(applyBedtimeSources("both", FOCUS)).toBe(false);
    expect(applyBedtimeSources("both", F)).toBe(false);
  });
});
