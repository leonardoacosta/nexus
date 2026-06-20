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
 * (`macLocked`, `macHost`). Phase 1.5 (mac-presence-observer) widens this with
 * the phone fields (`phonePresent`, `phoneHome` — agent-side Tailscale) and the
 * mac sensor fields (`macIdleSec`, `macFocus`). Watch fields arrive later still.
 */

/** Trust level for a presence field. `unknown` = stale-past-TTL or never set. */
export type Confidence = "high" | "medium" | "low" | "unknown";

/**
 * Origin of a presence field's value. `agent-cli` is the existing meeting-state
 * machine; `mac`/`phone`/`watch` are device reporters (later phases); `derived`
 * is an agent-side computation (the Tailscale `phonePresent`/`phoneHome` poller,
 * Phase 1.5); `test` is reserved for fixtures.
 */
export type Source = "agent-cli" | "mac" | "phone" | "watch" | "derived" | "test";

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
  /**
   * True when the phone has a Focus mode active (`INFocusStatusCenter`), Phase 2
   * (ios-presence-reporter). A GLOBAL phone field (one phone) overlaid onto the
   * resolved eval vector before rule evaluation; `unknown` (best-effort — the
   * user may not share Focus, or the report aged past TTL) applies no Focus
   * respect (fail-open to normal delivery).
   */
  phoneFocusOn: PresenceField<boolean>;
  /**
   * True when the user's phone is reachable on the tailnet (Phase 1.5). Derived
   * agent-side from `tailscale status --json` — an absent/offline peer reads
   * `unknown` (value null), never a stale `false`.
   */
  phonePresent: PresenceField<boolean>;
  /**
   * True when the phone is on the home LAN — its Tailscale endpoint is a
   * direct RFC1918 address (Phase 1.5). A public address or DERP relay reads
   * `false`; an absent peer reads `unknown` (phone home is indeterminate).
   */
  phoneHome: PresenceField<boolean>;
  /** Seconds the Mac HID has been idle, reported by the headless sensor (Phase 1.5). */
  macIdleSec: PresenceField<number>;
  /** The Mac's active Focus mode identifier (e.g. "work", "sleep"), or null (Phase 1.5). */
  macFocus: PresenceField<string>;
}
