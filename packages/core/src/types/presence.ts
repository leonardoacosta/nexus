/**
 * Presence vector types — the per-user context the agent holds for
 * presence-aware notification routing (openspec/changes/context-aware-routing,
 * Phase 1).
 *
 * Each field carries not just a value but provenance: which reporter set it
 * (`source`), when (`updatedAt`), and how trustworthy it is (`confidence`).
 * A field read past its TTL collapses to `confidence: "unknown"` with a `null`
 * value so the rules engine never acts on a stale truth — see
 * `presence-context.ts` for the TTL machinery and the staleness policy.
 *
 * Phase 1 ships ONLY the fields the two shipping rules consume (`macActive`,
 * `inMeeting`, `meetingEndsAt`, `isBedtime`) plus the mac-identity fields
 * (`macLocked`, `macHost`). Phone / watch fields arrive in later phases.
 */

/** Trust level for a presence field. `unknown` = stale-past-TTL or never set. */
export type Confidence = "high" | "medium" | "low" | "unknown";

/**
 * Origin of a presence field's value. `agent-cli` is the existing meeting-state
 * machine; `mac`/`phone`/`watch` are device reporters (later phases); `test`
 * is reserved for fixtures.
 */
export type Source = "agent-cli" | "mac" | "phone" | "watch" | "test";

/**
 * One field of the presence vector. `value` is `null` exactly when the field is
 * `unknown` (never set, or read past TTL). When `confidence` is `"unknown"`
 * consumers MUST treat `value` as absent regardless of its runtime contents.
 */
export interface PresenceField<T> {
  value: T | null;
  source: Source;
  /** ISO-8601 timestamp of when the value was reported. */
  updatedAt: string;
  confidence: Confidence;
}

/**
 * The per-user presence vector. Single-user model (nx is single-user, Q6) but
 * keyed by `userId` so a future fleet merge is a non-breaking widening.
 *
 * Phase 1 fields only.
 */
export interface PresenceVector {
  userId: string;
  /** True when the user is actively using a Mac (not idle / locked). */
  macActive: PresenceField<boolean>;
  /** True when the live Mac is locked. */
  macLocked: PresenceField<boolean>;
  /** Host name of the active Mac — the TTS delivery target. */
  macHost: PresenceField<string>;
  /** True when the user is in a meeting (fed by meeting-state + reporters). */
  inMeeting: PresenceField<boolean>;
  /** ISO-8601 timestamp the current meeting is expected to end, or null. */
  meetingEndsAt: PresenceField<string>;
  /** True when the current time is inside the user's bedtime window. */
  isBedtime: PresenceField<boolean>;
}
