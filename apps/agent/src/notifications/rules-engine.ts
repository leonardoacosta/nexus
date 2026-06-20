/**
 * Presence rules engine (openspec/changes/context-aware-routing, Phase 1).
 *
 * Priority-ordered, first-match-wins evaluator that consumes a `PresenceVector`
 * and produces a closed `Action`. This replaces the flat per-project
 * `findMatchingRule` for the presence-aware path; the legacy project /
 * `meeting_behavior` fallback stays in `router.ts` and is selected when
 * `presence_aware_routing` is off (see `router.ts`).
 *
 * Shipping rules (priority-ordered):
 *   - Rule 1 — active Mac, NOT in meeting → banner + tts to the live host.
 *     This rule MUST win even during bedtime (decision Q1: an active Mac beats
 *     bedtime — TTS at your desk even at 2am).
 *   - Rule 2 — Mac present AND in meeting → HOLD until (meetingEndsAt ?? now+60m)
 *     + a 2-minute buffer, delivered later as a coalesced digest.
 *   - Rule 4 — (NOT macActive OR macLocked) AND phonePresent AND phoneHome →
 *     room-audible `tts` to `macHost` (Phase 1.5, mac-presence-observer). The
 *     Mac is idle/locked but you are home with your phone, so the local Mac
 *     speaks the notification into the room. Documented order places Rule 4
 *     AFTER the bedtime rule and BEFORE the phone-away rule (both deferred);
 *     in the current spine that is between Rule 2 and the terminal fallback.
 *   - Terminal fallback — no rule matches → deliverTo:[dashboard], digest. The
 *     notification is NEVER silently dropped.
 *
 * Rule 0 (critical), the bedtime rule, the phone-away rule, and Rules 5–8 are
 * deferred to later phases. The staleness policy hook is implemented: a
 * rule-relevant field read as `unknown` simply fails the rule's guard, so a
 * vector with an unknown `phoneHome` never fires Rule 4's room-TTS (non-critical
 * fail-safe) and falls through to the terminal digest. Critical fail-open is a
 * no-op this phase because Rule 0 is deferred.
 */

import type { Action, PresenceVector } from "@nexus/core";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:notifications:rules-engine");

/** Default buffer added after a meeting ends before flushing held items. */
export const MEETING_BUFFER_MS = 2 * 60_000;

/** Safety cap when a meeting has no known end time. */
export const MEETING_CAP_MS = 60 * 60_000;

/**
 * Read a boolean field as a definite `true`. An `unknown`/null field is NOT
 * true — this is how the staleness policy short-circuits a rule guard
 * (fail-safe: an unknown field never satisfies a positive condition).
 */
function isTrue(field: { value: boolean | null; confidence: string }): boolean {
  return field.confidence !== "unknown" && field.value === true;
}

/** Read a boolean field as a definite `false` (known and false). */
function isFalse(field: { value: boolean | null; confidence: string }): boolean {
  return field.confidence !== "unknown" && field.value === false;
}

/** A field is "present" (known) when its confidence is not unknown. */
function isKnown(field: { confidence: string }): boolean {
  return field.confidence !== "unknown";
}

/**
 * True iff EVERY presence field is `unknown` — i.e. the agent has no idea
 * where the user is (no Mac sensor, no phone poll, no meeting state). On a
 * headless agent (e.g. the homelab box with no Mac sensor) every field reads
 * `unknown`, so `evaluateRules` would fall to its terminal digest fallback
 * (dashboard-only, no banner/TTS). The router uses this to fall back to the
 * byte-identical legacy path instead — "I don't know where you are" must
 * behave exactly as today (loud), NOT suppress to a silent digest.
 *
 * A vector with ANY known field is NOT all-unknown and still flows through
 * `evaluateRules` normally.
 */
export function isVectorAllUnknown(vector: PresenceVector): boolean {
  return (
    !isKnown(vector.macActive) &&
    !isKnown(vector.macLocked) &&
    !isKnown(vector.macHost) &&
    !isKnown(vector.inMeeting) &&
    !isKnown(vector.meetingEndsAt) &&
    !isKnown(vector.isBedtime) &&
    !isKnown(vector.phonePresent) &&
    !isKnown(vector.phoneHome) &&
    !isKnown(vector.macIdleSec) &&
    !isKnown(vector.macFocus)
  );
}

function baseAction(): Action {
  return {
    banner: false,
    ding: false,
    tts: false,
    deliverTo: [],
    deliveryMode: "simultaneous",
    interruptionLevel: "passive",
    collapseId: "",
    stopPropagation: false,
    holdUntil: null,
    digest: false,
    redact: "full",
  };
}

/**
 * Evaluate the presence vector against the priority rule list and return the
 * winning `Action`. First-match-wins, top to bottom.
 */
export function evaluateRules(vector: PresenceVector): Action {
  // ── Rule 1 — Active on Mac, NOT in meeting (Q1: beats bedtime) ──────────
  // Guard: macActive known-true AND inMeeting known-false. Note bedtime is
  // intentionally NOT consulted here — an active Mac outranks the bedtime
  // rule (which is Rules 3+, deferred), so a 2am desk session still speaks.
  if (isTrue(vector.macActive) && isFalse(vector.inMeeting)) {
    log.debug({ macHost: vector.macHost.value }, "rules: matched Rule 1 (active Mac)");
    return {
      ...baseAction(),
      banner: true,
      tts: true,
      deliverTo: ["mac"],
      deliveryMode: "simultaneous",
      interruptionLevel: "active",
      redact: "titlesOnly",
    };
  }

  // ── Rule 2 — Mac present AND in meeting → HOLD ──────────────────────────
  // "mac present" = any mac field known (active or locked or host). Phase 1
  // consumes `inMeeting` straight from the vector (the (camera||mic) &&
  // (app||calendar) AND-gate is the reporter's job, not the engine's).
  const macPresent =
    isKnown(vector.macActive) ||
    isKnown(vector.macLocked) ||
    isKnown(vector.macHost);
  if (macPresent && isTrue(vector.inMeeting)) {
    const now = Date.now();
    const endsAt =
      vector.meetingEndsAt.confidence !== "unknown" &&
      vector.meetingEndsAt.value
        ? new Date(vector.meetingEndsAt.value).getTime()
        : now + MEETING_CAP_MS;
    const holdUntil = new Date(endsAt + MEETING_BUFFER_MS).toISOString();
    log.debug({ holdUntil }, "rules: matched Rule 2 (meeting hold)");
    return {
      ...baseAction(),
      digest: true,
      holdUntil,
      deliverTo: ["mac"],
      interruptionLevel: "passive",
    };
  }

  // ── Rule 4 — idle/locked Mac + phone home → room-TTS (Phase 1.5) ────────
  // Guard: the Mac is NOT actively in use (idle: macActive known-false, OR
  // locked: macLocked known-true) AND you are present-and-home with your phone.
  // `phoneHome` MUST be known-true — an `unknown` phoneHome (stale Tailscale
  // poll) fails the guard and the notification falls through to the fail-safe
  // terminal digest (it does NOT speak into the room on indeterminate home
  // state). Delivers room-audible TTS to the local Mac host.
  const macIdleOrLocked = isFalse(vector.macActive) || isTrue(vector.macLocked);
  if (
    macIdleOrLocked &&
    isTrue(vector.phonePresent) &&
    isTrue(vector.phoneHome)
  ) {
    log.debug(
      { macHost: vector.macHost.value },
      "rules: matched Rule 4 (phone-home room-TTS)",
    );
    return {
      ...baseAction(),
      tts: true,
      deliverTo: ["mac"],
      deliveryMode: "simultaneous",
      interruptionLevel: "active",
      redact: "titlesOnly",
    };
  }

  // ── Terminal fallback — nothing matched, never drop ─────────────────────
  log.debug("rules: terminal fallback (dashboard digest)");
  return {
    ...baseAction(),
    deliverTo: ["dashboard"],
    digest: true,
    interruptionLevel: "passive",
  };
}
