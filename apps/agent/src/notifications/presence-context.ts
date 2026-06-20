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
import type { Db } from "@nexus/db";
import { lifecycleBus } from "../services/lifecycle-bus";
import { upsertSelfPresence } from "../services/fleet-presence";
import type { MeetingState } from "./meeting-state";

const log = createLogger("agent:notifications:presence-context");

/** TTL for the volatile mac fields (~30s per the spec). */
export const MAC_FIELD_TTL_MS = 30_000;

/**
 * Default heartbeat-tick interval for the `fleet_presence` row (~10s). Comfortably
 * under the 30s heartbeat TTL so a live machine is refreshed several times before
 * it could be deemed stale.
 */
export const FLEET_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * TTL for the Tailscale-derived phone fields (~2min, Phase 1.5). The poller
 * runs every few seconds, so a 2-minute window tolerates a handful of missed
 * ticks before the field collapses to `unknown` and Rule 4's fail-safe applies.
 */
export const PHONE_FIELD_TTL_MS = 120_000;

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
  // Phase 1.5 mac sensor fields share the volatile-mac TTL.
  macIdleSec: MAC_FIELD_TTL_MS,
  macFocus: MAC_FIELD_TTL_MS,
  // Phase 1.5 Tailscale-derived phone fields.
  phonePresent: PHONE_FIELD_TTL_MS,
  phoneHome: PHONE_FIELD_TTL_MS,
};

/**
 * The reportable fields (everything except the `userId` discriminator). Phase
 * 1.5 widens this with the phone fields (`phonePresent`/`phoneHome`, set by the
 * Tailscale poller) and the mac sensor fields (`macIdleSec`/`macFocus`).
 */
export interface PresenceReport {
  macActive?: boolean;
  macLocked?: boolean;
  macHost?: string;
  inMeeting?: boolean;
  meetingEndsAt?: string | null;
  isBedtime?: boolean;
  phonePresent?: boolean;
  phoneHome?: boolean;
  macIdleSec?: number;
  macFocus?: string | null;
}

type FieldKey = Exclude<keyof PresenceVector, "userId">;

const FIELD_KEYS: FieldKey[] = [
  "macActive",
  "macLocked",
  "macHost",
  "inMeeting",
  "meetingEndsAt",
  "isBedtime",
  "phonePresent",
  "phoneHome",
  "macIdleSec",
  "macFocus",
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

/** Fields that, when reported, change the local Mac's live-console picture. */
const FLEET_RELEVANT_KEYS: ReadonlySet<FieldKey> = new Set<FieldKey>([
  "macActive",
  "macLocked",
]);

export class PresenceContext {
  private readonly userId: string;
  private fields: Record<FieldKey, StoredField>;
  private meetingState: MeetingState | null = null;

  // ── Fleet presence binding (cross-machine-delivery, Phase 1.6) ────────────
  private fleetDb: Db | null = null;
  private fleetMachine: string | null = null;
  private fleetTimer: ReturnType<typeof setInterval> | null = null;

  constructor(userId: string) {
    this.userId = userId;
    this.fields = {
      macActive: unknownField(),
      macLocked: unknownField(),
      macHost: unknownField(),
      inMeeting: unknownField(),
      meetingEndsAt: unknownField(),
      isBedtime: unknownField(),
      phonePresent: unknownField(),
      phoneHome: unknownField(),
      macIdleSec: unknownField(),
      macFocus: unknownField(),
    };
  }

  /** Bind the existing meeting-state machine as the `inMeeting` source. */
  bindMeetingState(meeting: MeetingState): void {
    this.meetingState = meeting;
  }

  /**
   * Bind the shared-DB fleet-presence store (cross-machine-delivery, Phase 1.6).
   *
   * Once bound, every presence change that touches a fleet-relevant field
   * (mac active/locked) upserts THIS machine's `fleet_presence` row, and a
   * heartbeat tick refreshes the row's `heartbeat` even with no change so a
   * live machine never looks stale. The upsert is fire-and-forget (a DB hiccup
   * must never block the notification path) and uses the DB's `now()` for a
   * server-authoritative heartbeat.
   *
   * `machine` is the local identity (agents.toml `self_name` via getAgentId()).
   */
  bindFleetPresence(
    db: Db,
    machine: string,
    intervalMs: number = FLEET_HEARTBEAT_INTERVAL_MS,
  ): void {
    this.fleetDb = db;
    this.fleetMachine = machine;
    // Write an initial row immediately so the fleet picture is populated on boot.
    this.upsertFleetPresence();
    if (this.fleetTimer) clearInterval(this.fleetTimer);
    this.fleetTimer = setInterval(() => this.upsertFleetPresence(), intervalMs);
    // Don't keep the event loop alive solely for the heartbeat.
    this.fleetTimer.unref?.();
    log.debug({ machine, intervalMs }, "presence: fleet-presence binding active");
  }

  /** Stop the fleet heartbeat tick (test teardown / shutdown). */
  unbindFleetPresence(): void {
    if (this.fleetTimer) clearInterval(this.fleetTimer);
    this.fleetTimer = null;
    this.fleetDb = null;
    this.fleetMachine = null;
  }

  /**
   * UPSERT this machine's fleet_presence row from the current vector. The local
   * machine is "on console" when its Mac is active AND not locked (both read
   * through the TTL lens, so a stale signal collapses to not-on-console).
   * Fire-and-forget — failures are logged, never thrown.
   */
  private upsertFleetPresence(): void {
    const db = this.fleetDb;
    const machine = this.fleetMachine;
    if (!db || !machine) return;

    const v = this.vector();
    const macActive = v.macActive.confidence !== "unknown" ? v.macActive.value : null;
    const macLocked = v.macLocked.confidence !== "unknown" ? v.macLocked.value : null;
    const onConsole = macActive === true && macLocked !== true;

    void upsertSelfPresence(db, machine, { onConsole, macActive, macLocked }).catch(
      (err) => {
        log.warn(
          { machine, err: err instanceof Error ? err.message : String(err) },
          "presence: fleet_presence upsert failed (non-fatal)",
        );
      },
    );
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

    // Mirror local presence changes into the shared fleet_presence store so
    // peers can resolve the live console (cross-machine-delivery, Phase 1.6).
    if (changed.some((k) => FLEET_RELEVANT_KEYS.has(k))) {
      this.upsertFleetPresence();
    }
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
      phonePresent: this.read<boolean>("phonePresent"),
      phoneHome: this.read<boolean>("phoneHome"),
      macIdleSec: this.read<number>("macIdleSec"),
      macFocus: this.read<string>("macFocus"),
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
  singleton?.unbindFleetPresence();
  singleton = null;
}
