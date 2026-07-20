/**
 * Lifecycle Event Bus
 *
 * Typed EventEmitter that acts as the central nervous system for the agent.
 * All significant state changes (session lifecycle, spec transitions,
 * credential swaps, notifications) are emitted here. The SSE endpoint
 * subscribes to this bus to propagate events to local listeners.
 *
 * Federation note: peer agent federation (peer-connector, /ws/federation,
 * `source: 'peer'`, `injectPeerEvent`) was removed by `remove-peer-connector`
 * (spine-migration). Cross-machine awareness now comes from clients reading
 * `agents.toml` and querying each agent directly.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "@nexus/core/node";
import type { BeadTransitionPayload } from "@nexus/core";

const log = createLogger("agent:lifecycle-bus");

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

export interface SessionStartedPayload {
  sessionId: string;
  project?: string;
  cwd?: string;
  model?: string;
}

export interface SessionStoppedPayload {
  sessionId: string;
}

/**
 * Emitted by the process-watcher reconciler when a new live `claude`
 * process is discovered and a session row is INSERTED. The payload carries
 * the discriminator fields the menu bar client needs to render the new
 * row without a follow-up GET.
 *
 * See: fix-agent-cc-session-tracking, task 2.7.
 */
export interface RemoteSessionStartedPayload {
  sessionId: string;
  pid: number;
  cwd?: string | null;
  model?: string | null;
  tmuxTarget?: string | null;
  machine?: string | null;
}

/**
 * Emitted by the process-watcher reconciler when a row whose PID is no
 * longer alive is marked `endedAt = NOW()`, `status = "ended"`.
 *
 * See: fix-agent-cc-session-tracking, task 2.7.
 */
export interface RemoteSessionEndedPayload {
  sessionId: string;
  pid: number;
}

export interface SessionHeartbeatPayload {
  sessionId: string;
  timestamp: string;
}

export interface StatusChangedPayload {
  sessionId: string;
  from: string;
  to: string;
}

export interface SpecTransitionPayload {
  project: string;
  specName: string;
  transition:
    | "new_spec"
    | "removed"
    | "progress"
    | "all_complete"
    | "hash_changed"
    // `status_change` — frontmatter status flipped via PATCH /specs/.../status
    // (specs-tab-start-on-spec). `toStatus` is the new value the file now
    // carries on disk; subscribers (SpecsView) reconcile their row pill
    // optimistically.
    | "status_change";
  completed?: number;
  total?: number;
  /** Present only when `transition === "status_change"`. */
  toStatus?: "draft" | "approved";
}

export interface CredentialSwapPayload {
  credentialId: string;
  reason: string;
}

export interface CredentialDecryptFallbackPayload {
  /** Agent that experienced the decrypt failure. */
  agentId: string;
  /**
   * Source channel that triggered the fallback (e.g. "tts").
   * Lets downstream consumers group fallback counts by emitter when other
   * channels eventually adopt the same signal.
   */
  source: string;
}

/**
 * Emitted when the user mutates `/notifications/settings` via PATCH.
 *
 * Payload carries the *post-update* values so subscribers (Mac listener
 * via SSE) can swap their cached toggles in one frame without a follow-up
 * GET. Field naming uses camelCase — DB columns (`tts_enabled`,
 * `banner_enabled`, `ducking_mode`, `signal_only`, `meeting_mode`,
 * `suppression_minutes`) are converted at the route boundary.
 *
 * `signalOnly` / `meetingMode` / `suppressionMinutes` added by
 * sync-notification-settings-round-trip (2026-07-20) so a settings change made
 * on one machine reaches every peer listener's cached gating state in one frame.
 */
export interface SettingsChangedPayload {
  ttsEnabled: boolean;
  bannerEnabled: boolean;
  duckingMode: "full" | "half" | "mute";
  signalOnly: boolean;
  meetingMode: boolean;
  suppressionMinutes: number;
}

/**
 * Emitted by `handleHooks` after every successful `appendSessionEvent` insert.
 *
 * Carries a lean projection — `eventType`, `sessionId`, optional `project`,
 * and the persisted row id (`eventId`). Subscribers MUST refetch the full row
 * from `/sessions/:id/events` (or sibling endpoints) to read metadata; the bus
 * never broadcasts the full hook payload (privacy + size).
 *
 * `count` is populated by `hook-event-throttle.ts` when high-frequency
 * event types (`tool_use_start`, `tool_use_end`) coalesce within a 500ms
 * window. When undefined or 1, the emit corresponds to a single event;
 * when >1, `eventId` points to the LAST suppressed event in the window.
 *
 * See: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 */
export interface HookEventReceivedPayload {
  eventType: string;
  sessionId: string;
  project?: string;
  eventId: number;
  count?: number;
}

/**
 * Emitted when the schema-drift detector observes a *new*
 * `(event_type, fingerprint)` pair in an incoming hook payload.
 *
 * Spec: openspec/changes/add-schema-drift-detector
 *
 * Rate-limited at the emitter to one fire per `event_type` per hour — see
 * `services/schema-drift.ts` (`DRIFT_RATE_LIMIT_MS`). Subscribers MAY
 * trigger telemetry, alerts, or dashboards on this event; they MUST be
 * idempotent because rate-limit state is per-process and resets on restart.
 */
export interface HookSchemaDriftPayload {
  /** Event type whose payload shape changed (e.g. "PreToolUse"). */
  eventType: string;
  /** SHA-256 of the sorted top-level key set for the new payload shape. */
  fingerprint: string;
  /** ISO-8601 timestamp of the first observation of this fingerprint. */
  firstSeen: string;
}

export interface NotificationFiredPayload {
  /** Notification id (idempotency key). */
  id: string;
  /** Banner title (shown on desktop); TTS ignores title. */
  title: string;
  /** Full message body — used as TTS text and banner subtitle. */
  body: string;
  /** Delivery channel: "desktop" | "tts" (slack removed by remove-slack-channel). */
  channel: string;
  /** Optional project scope. */
  project?: string;
  /** @deprecated Use `body` instead. Kept for subscribers on the old schema. */
  message?: string;
  /**
   * Optional bullet-list items rendered by the Mac listener as a structured
   * sub-list under the banner body. First consumer: `reaper-job.ts` — emits
   * one entry per bloat finding. Other emitters MAY use this for structured
   * multi-line content (e.g. per-spec status lists).
   *
   * Added by `adopt-reaper-into-nx-cron`. Optional + back-compat — existing
   * emitters omit it and existing renderers ignore it.
   */
  items?: string[];
  /**
   * Optional absolute path to a log file the user can open from the
   * notification activation. The Mac listener opens this via the OS default
   * handler when present, fixing the raw-osascript click-attribution bug.
   *
   * Added by `adopt-reaper-into-nx-cron`. Optional + back-compat.
   */
  logPath?: string;
  /**
   * Base64-encoded MP3 audio produced by the agent-side ElevenLabs synth
   * path (analytics-query-and-tts-synthesis). Present only when:
   *   - `channel === "tts"`
   *   - `ELEVENLABS_API_KEY` is set in the agent's environment
   *   - The synth call returned a 2xx with mp3 bytes
   * The Mac listener falls back to its own local synth path when this
   * field is absent — back-compat with `swift-owns-elevenlabs-synth`.
   */
  audioBase64?: string;
  /** ElevenLabs voice id used for the synth call. Pairs with `audioBase64`. */
  voiceUsed?: string;
  /**
   * CC custom session name — the `/rename` title persisted as `customTitle`
   * in the transcript jsonl (nx-20caf). Threaded transport-only through the
   * NotificationManager `extras` mechanism (mirrors `items` / `logPath`), so
   * no DB column is added. The Swift consumer + statusline read this to name
   * the originating session in the banner / spoken text. Absent (undefined)
   * when the upstream hook payload had no custom title — consumers MUST
   * degrade gracefully to today's session-less rendering.
   */
  sessionName?: string;
  /**
   * CC session id (the transcript/session uuid) of the originating Claude
   * Code session. Threaded transport-only alongside `sessionName` (mx-7i4k)
   * so the iOS alert push can carry it in `userInfo.sessionId`; the
   * `NexusAppDelegate` tap-router keys on this to deep-link the banner tap
   * straight to that session's detail view. Absent (undefined) for
   * non-session notifications (e.g. reaper stale-heartbeat) — consumers MUST
   * degrade gracefully to opening the app's default view.
   */
  sessionId?: string;
  /** Optional URL for the iOS APNS push to open in Safari on tap. Added by `iopen`. Mac renderers ignore this. */
  url?: string;
}

/**
 * Emitted when a `/notifications/voices/:project` PUT or DELETE commits.
 *
 * The Mac TTSObserver subscribes to this event on the SSE stream and
 * refreshes its `projectVoiceCache` so per-project voice resolution
 * picks up the new mapping without a poll cycle.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.7)
 */
export interface VoiceOverrideChangedPayload {
  /** Project slug whose override was inserted, updated, or deleted. */
  project: string;
}

/**
 * Emitted by the process-watcher when the latest tick is stale
 * (`tickAgeSeconds > 30`) or the latest persisted row carries an
 * `errorText`. Subscribers (alert pipelines, dashboards) MAY treat this
 * as a "watcher is unhealthy" trigger. Idempotent on the consumer side —
 * the emitter does NOT rate-limit, so back-to-back stalled ticks each
 * fire one event.
 *
 * Spec: process-watcher-health-monitoring.
 */
export interface ProcessWatcherStalledPayload {
  /** Seconds since the last tick completed. */
  tickAgeSeconds: number;
  /** Error message from the latest persisted row, or null. */
  errorText: string | null;
  /** Live pid count from the latest tick. */
  livePidCount: number;
}

/**
 * Emitted by `presence-context.ts` on every merge of reported presence fields
 * into the per-user vector (openspec/changes/context-aware-routing).
 *
 * `vector` is the post-merge snapshot (fields read through the TTL lens, so
 * stale fields already appear as `unknown`). `changed` lists the field keys
 * that this merge actually updated, so subscribers can react narrowly without
 * diffing the whole vector.
 */
export interface PresenceChangedPayload {
  /** Post-merge presence vector snapshot. */
  vector: import("@nexus/core").PresenceVector;
  /** Field keys updated by this merge. */
  changed: (keyof import("@nexus/core").PresenceVector)[];
}

/**
 * Emitted by the held-queue when a held notification flushes at its
 * `holdUntil` (openspec/changes/context-aware-routing). Carries only the
 * notification id — subscribers refetch detail as needed (mirrors the lean
 * projection convention used by `HookEventReceived`).
 */
export interface PresenceHoldReleasedPayload {
  /** Notification id of the flushed hold. */
  id: string;
}

/**
 * Emitted by `services/status-snapshots.ts` when a project's unlinked
 * ready/blocked bead counts change (the change-only snapshot comparison
 * doubles as the emission gate). Symmetric with `SpecTransition`: carries the
 * project, the before/after counts, and the change time.
 *
 * Field shape is reused verbatim from `@nexus/core`'s `beadTransitionPayload`
 * so the wire contract stays single-sourced with the DB columns and the
 * `GET /projects/:id/status` response. No SSE special-casing is needed — the
 * `subscribeStreamToBus` wildcard (`onAny`) forwards every envelope, so this
 * event reaches the SSE stream for free.
 *
 * Spec: openspec/changes/add-project-status-snapshots/ (spec-watcher delta).
 */
export type { BeadTransitionPayload };

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export interface LifecycleEventMap {
  SessionStarted: SessionStartedPayload;
  SessionStopped: SessionStoppedPayload;
  SessionHeartbeat: SessionHeartbeatPayload;
  StatusChanged: StatusChangedPayload;
  SpecTransition: SpecTransitionPayload;
  CredentialSwap: CredentialSwapPayload;
  CredentialDecryptFallback: CredentialDecryptFallbackPayload;
  NotificationFired: NotificationFiredPayload;
  SettingsChanged: SettingsChangedPayload;
  HookEventReceived: HookEventReceivedPayload;
  HookSchemaDrift: HookSchemaDriftPayload;
  RemoteSessionStarted: RemoteSessionStartedPayload;
  RemoteSessionEnded: RemoteSessionEndedPayload;
  VoiceOverrideChanged: VoiceOverrideChangedPayload;
  ProcessWatcherStalled: ProcessWatcherStalledPayload;
  PresenceChanged: PresenceChangedPayload;
  PresenceHoldReleased: PresenceHoldReleasedPayload;
  BeadTransition: BeadTransitionPayload;
}

export type LifecycleEventName = keyof LifecycleEventMap;

// ---------------------------------------------------------------------------
// Envelope: wraps every event with metadata
// ---------------------------------------------------------------------------

export interface LifecycleEnvelope<K extends LifecycleEventName = LifecycleEventName> {
  event: K;
  payload: LifecycleEventMap[K];
  /** Monotonic sequence number. */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Originating agent name. */
  origin?: string;
}

// ---------------------------------------------------------------------------
// Bus implementation
// ---------------------------------------------------------------------------

export type LifecycleHandler<K extends LifecycleEventName> = (
  envelope: LifecycleEnvelope<K>,
) => void;

export class LifecycleBus {
  private readonly emitter = new EventEmitter();
  private seq = 0;
  private originName: string | undefined;

  constructor() {
    // Allow many subscribers (SSE, notification router, etc.)
    this.emitter.setMaxListeners(50);
  }

  /** Set the origin agent name (from agents.toml self_name). */
  setOrigin(name: string): void {
    this.originName = name;
  }

  /** Subscribe to a specific event type. */
  on<K extends LifecycleEventName>(
    event: K,
    handler: LifecycleHandler<K>,
  ): void {
    this.emitter.on(event, handler);
  }

  /** Unsubscribe from a specific event type. */
  off<K extends LifecycleEventName>(
    event: K,
    handler: LifecycleHandler<K>,
  ): void {
    this.emitter.off(event, handler);
  }

  /** Subscribe to ALL event types via a wildcard listener. */
  onAny(handler: (envelope: LifecycleEnvelope) => void): void {
    this.emitter.on("*", handler);
  }

  /** Unsubscribe from the wildcard listener. */
  offAny(handler: (envelope: LifecycleEnvelope) => void): void {
    this.emitter.off("*", handler);
  }

  /**
   * Emit a lifecycle event.
   *
   * Each emit gets an incrementing sequence number and an ISO timestamp.
   */
  emit<K extends LifecycleEventName>(
    event: K,
    payload: LifecycleEventMap[K],
  ): LifecycleEnvelope<K> {
    const envelope: LifecycleEnvelope<K> = {
      event,
      payload,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      origin: this.originName,
    };

    log.debug({ event, seq: envelope.seq }, "lifecycle-bus: emit");
    this.emitter.emit(event, envelope);
    this.emitter.emit("*", envelope);
    return envelope;
  }

  /** Current sequence number (for testing). */
  get currentSeq(): number {
    return this.seq;
  }

  /** Number of wildcard (`onAny`) listeners — for testing leak cleanup. */
  get wildcardListenerCount(): number {
    return this.emitter.listenerCount("*");
  }

  /** Remove all listeners (for testing teardown). */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const lifecycleBus = new LifecycleBus();
