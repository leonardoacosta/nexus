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

import { evaluateRules } from "./rules-engine";
import { decidePresenceRoute, actionToChannels } from "./router";

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
}> = {}): PresenceVector {
  return {
    userId: "leo",
    macActive: field(overrides.macActive ?? null),
    macLocked: field(overrides.macLocked ?? null),
    macHost: field(overrides.macHost ?? null),
    inMeeting: field(overrides.inMeeting ?? null),
    meetingEndsAt: field(overrides.meetingEndsAt ?? null),
    isBedtime: field(overrides.isBedtime ?? null),
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
