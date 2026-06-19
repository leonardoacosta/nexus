/**
 * Presence context — the agent-held, per-user `PresenceVector`
 * (openspec/changes/context-aware-routing, Phase 1).
 *
 * Single-user model (nx is single-user, Q6) but keyed by `userId` so a future
 * fleet merge is a non-breaking widening. The vector is in-memory: reporters
 * push partial updates via `report()` (the `POST /presence/report` ingest and,
 * later, device observers), and the existing meeting-state machine feeds
 * `inMeeting` via `bindMeetingState()` + `syncMeetingState()`.
 *
 * Staleness is enforced at READ time: each field carries its own TTL, and a
 * read past the TTL collapses to `{ value: null, confidence: "unknown" }` so
 * the rules engine never acts on a stale truth. The stored value is retained
 * internally (for debugging) but never surfaced once stale.
 */

import type {
  Confidence,
  PresenceField,
  PresenceVector,
  Source,
} from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import { lifecycleBus } from "../services/lifecycle-bus";
import type { MeetingState } from "./meeting-state";

const log = createLogger("agent:notifications:presence-context");

/** TTL for the volatile mac fields (~30s per the spec). */
export const MAC_FIELD_TTL_MS = 30_000;

/**
 * Per-field TTL in ms. Fields absent from this map are treated as non-expiring
 * (e.g. `isBedtime`, `meetingEndsAt` are derived/long-lived and only change on
 * an explicit report).
 */
const FIELD_TTL_MS: Partial<Record<keyof PresenceVector, number>> = {
  macActive: MAC_FIELD_TTL_MS,
  macLocked: MAC_FIELD_TTL_MS,
  macHost: MAC_FIELD_TTL_MS,
  inMeeting: MAC_FIELD_TTL_MS,
};

/** The reportable Phase-1 fields (everything except the `userId` discriminator). */
export interface PresenceReport {
  macActive?: boolean;
  macLocked?: boolean;
  macHost?: string;
  inMeeting?: boolean;
  meetingEndsAt?: string | null;
  isBedtime?: boolean;
}

type FieldKey = Exclude<keyof PresenceVector, "userId">;

const FIELD_KEYS: FieldKey[] = [
  "macActive",
  "macLocked",
  "macHost",
  "inMeeting",
  "meetingEndsAt",
  "isBedtime",
];

/** A stored field before the TTL lens is applied. */
interface StoredField {
  value: unknown;
  source: Source;
  updatedAt: string;
  confidence: Confidence;
}

function unknownField(): StoredField {
  return {
    value: null,
    source: "agent-cli",
    updatedAt: new Date(0).toISOString(),
    confidence: "unknown",
  };
}

export class PresenceContext {
  private readonly userId: string;
  private fields: Record<FieldKey, StoredField>;
  private meetingState: MeetingState | null = null;

  constructor(userId: string) {
    this.userId = userId;
    this.fields = {
      macActive: unknownField(),
      macLocked: unknownField(),
      macHost: unknownField(),
      inMeeting: unknownField(),
      meetingEndsAt: unknownField(),
      isBedtime: unknownField(),
    };
  }

  /** Bind the existing meeting-state machine as the `inMeeting` source. */
  bindMeetingState(meeting: MeetingState): void {
    this.meetingState = meeting;
  }

  /**
   * Pull the current meeting-state into the vector's `inMeeting` field with
   * source `agent-cli`. Call after every meeting-state transition. Emits
   * `PresenceChanged` if `inMeeting` actually changed.
   */
  syncMeetingState(): void {
    if (!this.meetingState) return;
    this.report({ inMeeting: this.meetingState.active }, "agent-cli");
  }

  /**
   * Merge a partial report into the vector. Only keys present (and not
   * `undefined`) are updated. Emits a single `PresenceChanged` carrying the
   * post-merge snapshot + the list of changed keys. `at` overrides the
   * `updatedAt` stamp (used by tests to simulate stale fields).
   */
  report(
    report: PresenceReport,
    source: Source,
    at: string = new Date().toISOString(),
  ): void {
    const changed: FieldKey[] = [];

    for (const key of FIELD_KEYS) {
      if (!(key in report)) continue;
      const incoming = (report as Record<string, unknown>)[key];
      if (incoming === undefined) continue;
      this.fields[key] = {
        value: incoming,
        source,
        updatedAt: at,
        confidence: "high",
      };
      changed.push(key);
    }

    if (changed.length === 0) return;

    log.debug({ userId: this.userId, changed, source }, "presence: merged report");
    lifecycleBus.emit("PresenceChanged", {
      vector: this.vector(),
      changed,
    });
  }

  /**
   * Read the field through the TTL lens. A field whose `updatedAt` is older
   * than its TTL collapses to `unknown` (value null) — never the stale truth.
   */
  private read<T>(key: FieldKey): PresenceField<T> {
    const f = this.fields[key];
    if (f.confidence === "unknown") {
      return {
        value: null,
        source: f.source,
        updatedAt: f.updatedAt,
        confidence: "unknown",
      };
    }
    const ttl = FIELD_TTL_MS[key];
    if (ttl !== undefined) {
      const age = Date.now() - new Date(f.updatedAt).getTime();
      if (age > ttl) {
        return {
          value: null,
          source: f.source,
          updatedAt: f.updatedAt,
          confidence: "unknown",
        };
      }
    }
    return {
      value: f.value as T,
      source: f.source,
      updatedAt: f.updatedAt,
      confidence: f.confidence,
    };
  }

  /** Snapshot the vector with the TTL lens applied to every field. */
  vector(): PresenceVector {
    return {
      userId: this.userId,
      macActive: this.read<boolean>("macActive"),
      macLocked: this.read<boolean>("macLocked"),
      macHost: this.read<string>("macHost"),
      inMeeting: this.read<boolean>("inMeeting"),
      meetingEndsAt: this.read<string>("meetingEndsAt"),
      isBedtime: this.read<boolean>("isBedtime"),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton (single-user model)
// ---------------------------------------------------------------------------

/** Default user id for the single-user nx deployment. */
export const DEFAULT_PRESENCE_USER =
  process.env.NEXUS_PRESENCE_USER ?? "local";

let singleton: PresenceContext | null = null;

/** The process-wide presence context (single-user model, Q6). */
export function getPresenceContext(): PresenceContext {
  if (!singleton) {
    singleton = new PresenceContext(DEFAULT_PRESENCE_USER);
  }
  return singleton;
}

/** Reset the singleton — test teardown only. */
export function __resetPresenceContext(): void {
  singleton = null;
}
