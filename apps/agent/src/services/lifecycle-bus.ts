/**
 * Lifecycle Event Bus
 *
 * Typed EventEmitter that acts as the central nervous system for the agent.
 * All significant state changes (session lifecycle, spec transitions,
 * credential swaps, notifications) are emitted here. The peer connector
 * and SSE endpoint subscribe to this bus to propagate events.
 *
 * Events originating from peer agents carry `source: 'peer'` to prevent
 * re-forwarding (echo suppression).
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
  transition: "new_spec" | "removed" | "progress" | "all_complete" | "hash_changed";
  completed?: number;
  total?: number;
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

export interface NotificationFiredPayload {
  /** Notification id (idempotency key). */
  id: string;
  /** Banner title (shown on desktop); TTS ignores title. */
  title: string;
  /** Full message body — used as TTS text and banner subtitle. */
  body: string;
  /** Delivery channel: "desktop" | "tts" | "slack". */
  channel: string;
  /** Optional project scope. */
  project?: string;
  /**
   * Base64-encoded mp3 bytes from ElevenLabs.
   *
   * Present only when the TTS channel synthesized audio (i.e. the agent
   * had `ELEVENLABS_API_KEY` set). Absent on text-only channels (desktop,
   * slack) and on TTS events emitted from listeners that don't own the
   * ElevenLabs contract (e.g. the legacy socket-server dispatcher).
   *
   * Subscribers MUST tolerate this field being undefined.
   */
  audioBase64?: string;
  /** @deprecated Use `body` instead. Kept for subscribers on the old schema. */
  message?: string;
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
  RemoteSessionStarted: RemoteSessionStartedPayload;
  RemoteSessionEnded: RemoteSessionEndedPayload;
}

export type LifecycleEventName = keyof LifecycleEventMap;

// ---------------------------------------------------------------------------
// Envelope: wraps every event with metadata
// ---------------------------------------------------------------------------

export interface LifecycleEnvelope<K extends LifecycleEventName = LifecycleEventName> {
  event: K;
  payload: LifecycleEventMap[K];
  source: "local" | "peer";
  /** Monotonic sequence number (local only). */
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
    // Allow many subscribers (SSE, federation, notification router, etc.)
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
   * Local events get `source: 'local'` and an incrementing sequence number.
   * Peer-sourced events should use `injectPeerEvent()` instead.
   */
  emit<K extends LifecycleEventName>(
    event: K,
    payload: LifecycleEventMap[K],
  ): LifecycleEnvelope<K> {
    const envelope: LifecycleEnvelope<K> = {
      event,
      payload,
      source: "local",
      seq: ++this.seq,
      ts: new Date().toISOString(),
      origin: this.originName,
    };

    log.debug({ event, seq: envelope.seq }, "lifecycle-bus: emit");
    this.emitter.emit(event, envelope);
    this.emitter.emit("*", envelope);
    return envelope;
  }

  /**
   * Inject an event received from a peer agent.
   *
   * Marked with `source: 'peer'` so the peer connector can filter it
   * out and avoid echo loops.
   */
  injectPeerEvent(envelope: LifecycleEnvelope): void {
    // Overwrite source to ensure peer tag is always set
    const peerEnvelope: LifecycleEnvelope = { ...envelope, source: "peer" };
    log.debug(
      { event: peerEnvelope.event, origin: peerEnvelope.origin },
      "lifecycle-bus: inject peer event",
    );
    this.emitter.emit(peerEnvelope.event, peerEnvelope);
    this.emitter.emit("*", peerEnvelope);
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
