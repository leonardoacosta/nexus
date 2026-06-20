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
import { createLogger, getAgentId } from "@nexus/core/node";
import type { Db } from "@nexus/db";
import { lifecycleBus } from "../services/lifecycle-bus";
import {
  upsertSelfPresence,
  type SelfPresenceState,
} from "../services/fleet-presence";
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
 * TTL for the iOS-reported GLOBAL phone fields (`isBedtime`, `phoneFocusOn`),
 * Phase 2 (ios-presence-reporter). iOS wakes are sparser than the Tailscale
 * poll (HKObserver / Focus-change / foreground only — no timer), so this is a
 * few minutes longer than the Tailscale phone TTL. A field older than this
 * reads `unknown` and the overlay does NOT override (fail-safe — bedtime won't
 * wrongly suppress a notification on a stale signal).
 */
export const GLOBAL_PHONE_FIELD_TTL_MS = 5 * 60_000;

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
  phoneFocusOn?: boolean;
}

/** The bedtime-source policy (a `notification_settings.bedtime_sources` value). */
export type BedtimeSources = "hk" | "focus" | "either" | "both";

/** The raw sleep signals the phone reports; the agent computes `isBedtime`. */
export interface BedtimeSignals {
  hkSleepWindow: boolean;
  sleepFocusActive: boolean;
}

/**
 * Compute `isBedtime` from the phone's two raw sleep signals per the
 * `bedtime_sources` policy (ios-presence-reporter, Phase 2). PURE — no I/O.
 *
 *   - `hk`     → the HealthKit sleep-window signal only.
 *   - `focus`  → the OS Sleep-Focus signal only.
 *   - `either` → bedtime when EITHER source is active (default).
 *   - `both`   → bedtime only when BOTH sources are active.
 */
export function applyBedtimeSources(
  setting: BedtimeSources,
  signals: BedtimeSignals,
): boolean {
  switch (setting) {
    case "hk":
      return signals.hkSleepWindow;
    case "focus":
      return signals.sleepFocusActive;
    case "both":
      return signals.hkSleepWindow && signals.sleepFocusActive;
    case "either":
    default:
      return signals.hkSleepWindow || signals.sleepFocusActive;
  }
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
  "phoneFocusOn",
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

/** Fields that, when reported, change a machine's live-console picture. */
const FLEET_RELEVANT_KEYS: ReadonlySet<FieldKey> = new Set<FieldKey>([
  "macActive",
  "macLocked",
]);

/** Build a fresh all-unknown field record for a newly-seen machine. */
function freshFields(): Record<FieldKey, StoredField> {
  return {
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
    phoneFocusOn: unknownField(),
  };
}

/**
 * Injectable fleet upsert (defaults to the real `upsertSelfPresence`). Tests
 * pass a fake to assert the per-machine write without a live DB.
 */
type FleetUpsertFn = (
  db: Db,
  machine: string,
  state: SelfPresenceState,
) => Promise<void>;

export class PresenceContext {
  private readonly userId: string;
  /** The local machine's identity — the key the manager's `vector()` reads. */
  private readonly localMachine: string;
  /**
   * Per-machine field maps (fleet-aware-rules-eval, Phase 1.7). Each reporting
   * machine (`macHost`, or the local machine when absent) owns its own TTL'd
   * field record so two Macs can never clobber each other's presence.
   */
  private machineFields = new Map<string, Record<FieldKey, StoredField>>();
  /**
   * GLOBAL phone fields (ios-presence-reporter, Phase 2). There is ONE phone,
   * so its `isBedtime`/`phoneFocusOn` are held OUTSIDE the per-machine map and
   * overlaid onto the resolved eval vector (which is keyed by the live-console
   * MACHINE). Each carries its own `GLOBAL_PHONE_FIELD_TTL_MS` lens — a field
   * past TTL reads `unknown` and the overlay does not override.
   */
  private globalPhone: { isBedtime: StoredField; phoneFocusOn: StoredField } = {
    isBedtime: unknownField(),
    phoneFocusOn: unknownField(),
  };
  private meetingState: MeetingState | null = null;

  // ── Fleet presence binding (cross-machine-delivery, Phase 1.6) ────────────
  private fleetDb: Db | null = null;
  private fleetMachine: string | null = null;
  private fleetTimer: ReturnType<typeof setInterval> | null = null;
  private fleetUpsert: FleetUpsertFn = upsertSelfPresence;

  /**
   * @param userId       the single-user discriminator (single-user model, Q6).
   * @param localMachine this agent's machine identity (agents.toml self_name
   *   via getAgentId()). Reports with no `macHost` key, and the manager's
   *   fallback `vector()`, resolve against this machine. Defaults to the local
   *   agent id so existing single-arg construction keeps working.
   */
  constructor(userId: string, localMachine: string = getAgentId()) {
    this.userId = userId;
    this.localMachine = localMachine;
    // Seed the local machine so `vector()` is always well-defined.
    this.machineFields.set(localMachine, freshFields());
  }

  /** The field record for `machine`, creating an all-unknown one on first use. */
  private fieldsFor(machine: string): Record<FieldKey, StoredField> {
    let f = this.machineFields.get(machine);
    if (!f) {
      f = freshFields();
      this.machineFields.set(machine, f);
    }
    return f;
  }

  /** Every machine identity the context has seen a report for. */
  machines(): string[] {
    return [...this.machineFields.keys()];
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
    upsertFn?: FleetUpsertFn,
  ): void {
    this.fleetDb = db;
    this.fleetMachine = machine;
    if (upsertFn) this.fleetUpsert = upsertFn;
    // Write an initial row immediately so the fleet picture is populated on boot.
    this.upsertFleetPresence(machine);
    if (this.fleetTimer) clearInterval(this.fleetTimer);
    // The heartbeat tick refreshes the LOCAL self-row so a live machine never
    // looks stale even with no presence change.
    this.fleetTimer = setInterval(() => this.upsertFleetPresence(machine), intervalMs);
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
    this.fleetUpsert = upsertSelfPresence;
  }

  /**
   * UPSERT `machine`'s fleet_presence row from ITS per-machine vector
   * (fleet-aware-rules-eval, Phase 1.7). A machine is "on console" when its Mac
   * is active AND not locked (both read through the TTL lens, so a stale signal
   * collapses to not-on-console). The FULL vector jsonb + the typed
   * `on_console`/`mac_active`/`mac_locked` columns are written together from the
   * SAME vector so the eval-path jsonb and the delivery-path typed columns can
   * never diverge. Fire-and-forget — failures are logged, never thrown.
   */
  private upsertFleetPresence(machine: string): void {
    const db = this.fleetDb;
    if (!db) return;

    const v = this.vectorFor(machine);
    const macActive = v.macActive.confidence !== "unknown" ? v.macActive.value : null;
    const macLocked = v.macLocked.confidence !== "unknown" ? v.macLocked.value : null;
    const onConsole = macActive === true && macLocked !== true;

    void this.fleetUpsert(db, machine, {
      onConsole,
      macActive,
      macLocked,
      vector: v,
    }).catch((err) => {
      log.warn(
        { machine, err: err instanceof Error ? err.message : String(err) },
        "presence: fleet_presence upsert failed (non-fatal)",
      );
    });
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
    // The report's machine identity is its `macHost` (the reporting Mac's
    // hostname); fall back to the local machine when absent (a headless sensor
    // report, or the meeting-state feed) — never write an unkeyed row.
    const machine =
      typeof report.macHost === "string" && report.macHost.length > 0
        ? report.macHost
        : this.localMachine;
    const fields = this.fieldsFor(machine);
    const changed: FieldKey[] = [];

    for (const key of FIELD_KEYS) {
      if (!(key in report)) continue;
      const incoming = (report as Record<string, unknown>)[key];
      if (incoming === undefined) continue;
      fields[key] = {
        value: incoming,
        source,
        updatedAt: at,
        confidence: "high",
      };
      changed.push(key);
    }

    if (changed.length === 0) return;

    log.debug(
      { userId: this.userId, machine, changed, source },
      "presence: merged report",
    );
    lifecycleBus.emit("PresenceChanged", {
      // The lifecycle payload carries the LOCAL machine's vector (back-compat
      // with the single-vector subscribers); fleet eval reads per-machine rows.
      vector: this.vector(),
      changed,
    });

    // Mirror this MACHINE's presence into the shared fleet_presence store so
    // peers can resolve the live console. A remote Mac reporting to a headless
    // agent now persists ITS OWN row (nx-vbv39), not only the local self-row.
    if (changed.some((k) => FLEET_RELEVANT_KEYS.has(k))) {
      this.upsertFleetPresence(machine);
    }
  }

  /**
   * Read `machine`'s field through the TTL lens. A field whose `updatedAt` is
   * older than its TTL collapses to `unknown` (value null) — never the stale
   * truth.
   */
  private read<T>(
    fields: Record<FieldKey, StoredField>,
    key: FieldKey,
  ): PresenceField<T> {
    const f = fields[key];
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

  /**
   * Snapshot a machine's vector with the TTL lens applied to every field. An
   * unseen machine reads an all-unknown vector (without creating a bucket).
   */
  vectorFor(machine: string): PresenceVector {
    const fields = this.machineFields.get(machine) ?? freshFields();
    return {
      userId: this.userId,
      macActive: this.read<boolean>(fields, "macActive"),
      macLocked: this.read<boolean>(fields, "macLocked"),
      macHost: this.read<string>(fields, "macHost"),
      inMeeting: this.read<boolean>(fields, "inMeeting"),
      meetingEndsAt: this.read<string>(fields, "meetingEndsAt"),
      isBedtime: this.read<boolean>(fields, "isBedtime"),
      phonePresent: this.read<boolean>(fields, "phonePresent"),
      phoneHome: this.read<boolean>(fields, "phoneHome"),
      macIdleSec: this.read<number>(fields, "macIdleSec"),
      macFocus: this.read<string>(fields, "macFocus"),
      phoneFocusOn: this.read<boolean>(fields, "phoneFocusOn"),
    };
  }

  /**
   * The LOCAL machine's vector — the manager's fallback source when no live
   * console resolves. Unchanged contract for single-machine fleets.
   */
  vector(): PresenceVector {
    return this.vectorFor(this.localMachine);
  }

  /**
   * Ingest a GLOBAL phone report (ios-presence-reporter, Phase 2). The phone
   * sends two raw sleep signals plus its Focus flag; the agent computes
   * `isBedtime` from `bedtimeSources` and stores both fields in the global
   * phone record (NOT a per-machine bucket — there is one phone). Fields not
   * present in the report are left untouched. `at` overrides the timestamp
   * (tests simulate a stale report).
   */
  reportPhone(
    report: {
      hkSleepWindow?: boolean;
      sleepFocusActive?: boolean;
      phoneFocusOn?: boolean;
    },
    bedtimeSources: BedtimeSources,
    at: string = new Date().toISOString(),
  ): void {
    const changed: ("isBedtime" | "phoneFocusOn")[] = [];

    // Compute isBedtime only when at least one sleep signal is present. Treat
    // an absent signal as false for the policy input (the phone reports the
    // current state of both signals on every wake).
    if (
      report.hkSleepWindow !== undefined ||
      report.sleepFocusActive !== undefined
    ) {
      const isBedtime = applyBedtimeSources(bedtimeSources, {
        hkSleepWindow: report.hkSleepWindow === true,
        sleepFocusActive: report.sleepFocusActive === true,
      });
      this.globalPhone.isBedtime = {
        value: isBedtime,
        source: "phone",
        updatedAt: at,
        confidence: "high",
      };
      changed.push("isBedtime");
    }

    if (report.phoneFocusOn !== undefined) {
      this.globalPhone.phoneFocusOn = {
        value: report.phoneFocusOn,
        source: "phone",
        updatedAt: at,
        confidence: "high",
      };
      changed.push("phoneFocusOn");
    }

    if (changed.length === 0) return;
    log.debug(
      { userId: this.userId, changed, bedtimeSources },
      "presence: merged phone report",
    );
  }

  /** Read a global phone field through the GLOBAL_PHONE_FIELD_TTL lens. */
  private readGlobalPhone(
    key: "isBedtime" | "phoneFocusOn",
    nowMs: number = Date.now(),
  ): PresenceField<boolean> {
    const f = this.globalPhone[key];
    if (f.confidence === "unknown") {
      return { value: null, source: f.source, updatedAt: f.updatedAt, confidence: "unknown" };
    }
    const age = nowMs - new Date(f.updatedAt).getTime();
    if (age > GLOBAL_PHONE_FIELD_TTL_MS) {
      return { value: null, source: f.source, updatedAt: f.updatedAt, confidence: "unknown" };
    }
    return {
      value: f.value as boolean,
      source: f.source,
      updatedAt: f.updatedAt,
      confidence: f.confidence,
    };
  }

  /**
   * Overlay the freshest GLOBAL phone fields (`isBedtime`, `phoneFocusOn`) onto
   * a resolved eval vector (ios-presence-reporter, Phase 2). Rule evaluation
   * runs against the live-console MACHINE's vector, but those two fields are
   * global to the single phone — so they are overlaid here, after the
   * live-console resolve and before `evaluateRules`.
   *
   * NO-REGRESSION INVARIANT: a phone field past its TTL (or never reported)
   * reads `unknown` and does NOT override the incoming vector's value. When no
   * phone has reported, BOTH overlays are no-ops and the returned vector is
   * field-identical to the input — behaviour equals Phase 1.7.
   */
  overlayGlobalPhoneFields(vector: PresenceVector): PresenceVector {
    const isBedtime = this.readGlobalPhone("isBedtime");
    const phoneFocusOn = this.readGlobalPhone("phoneFocusOn");
    return {
      ...vector,
      isBedtime: isBedtime.confidence === "unknown" ? vector.isBedtime : isBedtime,
      phoneFocusOn:
        phoneFocusOn.confidence === "unknown" ? vector.phoneFocusOn : phoneFocusOn,
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
