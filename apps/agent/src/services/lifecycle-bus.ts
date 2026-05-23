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
 * `banner_enabled`, `ducking_mode`) are converted at the route boundary.
 */
export interface SettingsChangedPayload {
  ttsEnabled: boolean;
  bannerEnabled: boolean;
  duckingMode: "full" | "half" | "mute";
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

  /** Remove all listeners (for testing teardown). */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const lifecycleBus = new LifecycleBus();
