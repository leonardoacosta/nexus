import type {
  Action,
  NotificationChannel,
  NotificationRule,
  PresenceVector,
} from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import { evaluateRules } from "./rules-engine";
import { captureException, addBreadcrumb } from "@sentry/node";
import { fetchWithTimeout } from "@nexus/core";
import type { Db } from "@nexus/db";
import { projectVoiceOverrides } from "@nexus/db";
import { eq } from "drizzle-orm";
import type { NotificationRow } from "./buffer";
import { isUnspeakable, stripBeadIds } from "./speakability";
import { writeAudio } from "./audio-store";

/**
 * Signal-only channel handler.
 *
 * Used for `desktop` after `remove-notification-channels` (P4) — the agent
 * owns NO desktop-banner duties; the Mac listener (nexus-mac via
 * NexusShared) renders banners. For `tts`, see `sendTtsNotification` below
 * — it was collapsed into this stub during a refactor and has been
 * restored (analytics-query-and-tts-synthesis).
 */
async function signalOnlyChannel(_notification: NotificationRow): Promise<boolean> {
  return true;
}

const sendDesktopNotification = signalOnlyChannel;

// ---------------------------------------------------------------------------
// TTS synthesis (analytics-query-and-tts-synthesis)
// ---------------------------------------------------------------------------

/**
 * Per-call DB handle for the TTS channel. Set at agent boot via
 * `setTtsDbHandle(db)`. Module-level (not injected via call sites) because
 * `CHANNEL_HANDLERS` is keyed by channel name and the handler signature
 * cannot grow without changing every caller; the manager already passes
 * each NotificationRow individually so DB injection at boot keeps the
 * dispatch arrow narrow.
 */
let ttsDbHandle: Db | null = null;

/** Install the DB handle the TTS channel uses for voice-override lookup. */
export function setTtsDbHandle(db: Db | null): void {
  ttsDbHandle = db;
}

/** ElevenLabs default voice id — fallback when no per-project override is set. */
function defaultVoiceId(): string | null {
  const v = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  return v && v.length > 0 ? v : null;
}

/**
 * Resolve the ElevenLabs voice id for a notification:
 *   1. per-project override row (project_voice_overrides) when project set
 *   2. ELEVENLABS_DEFAULT_VOICE_ID env var
 *   3. null → caller degrades to signal-only (Mac listener synthesizes
 *      locally); never a hard failure.
 *
 * Reuses the existing `projectVoiceOverrides` table — no new schema.
 */
async function resolveVoiceId(
  notification: NotificationRow,
): Promise<string | null> {
  if (notification.project && ttsDbHandle) {
    try {
      const row = await ttsDbHandle
        .select({ voiceId: projectVoiceOverrides.voiceId })
        .from(projectVoiceOverrides)
        .where(eq(projectVoiceOverrides.project, notification.project))
        .limit(1);
      if (row[0]) return row[0].voiceId;
    } catch (err) {
      log.warn(
        {
          project: notification.project,
          err: err instanceof Error ? err.message : String(err),
        },
        "tts: project voice override lookup failed (non-fatal, falling back)",
      );
    }
  }
  return defaultVoiceId();
}

/**
 * Send the notification body to ElevenLabs and return mp3 bytes.
 *
 * Structured errors (thrown — never returned):
 *   - HTTP 4xx/5xx → Error("elevenlabs http <status>")
 *   - Network/abort → underlying Error from fetchWithTimeout
 * The caller (`sendTtsNotification`) catches any throw and degrades to
 * signal-only `{ success: true }` so the notification still delivers and the
 * Mac listener synthesizes locally — synth is best-effort, never fatal.
 */
async function synthesizeViaElevenLabs(
  notification: NotificationRow,
  voiceId: string,
  apiKey: string,
): Promise<Uint8Array> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  // Sanitize bead-ID tokens out of the SPOKEN text only. The persisted row, the
  // desktop/banner body, and the Mac history all keep `notification.body`
  // untouched — this strip lives at the synthesis seam so IDs (e.g. `nx-2g2j4`)
  // are never read aloud as gibberish while remaining visible everywhere else.
  const spokenText = stripBeadIds(notification.body);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    timeout: 8_000,
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: spokenText,
      model_id: "eleven_turbo_v2",
    }),
  });
  if (!res.ok) {
    throw new Error(`elevenlabs http ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Real TTS channel handler — restored from the `signalOnlyChannel` stub by
 * `analytics-query-and-tts-synthesis`.
 *
 * TTS NEVER hard-fails. It always at least emits a signal-only
 * `NotificationFired` (success: true, no audio) so the Mac listener
 * (NexusShared.TTSObserver → ElevenLabsClient + Keychain) can synthesize
 * locally. Agent-side synthesis is a best-effort OPTIMIZATION: when it works
 * we pre-render the mp3 and ship it as `audioBase64` so the Mac can skip its
 * own synth round-trip; when it can't, we degrade to signal-only rather than
 * killing the whole notification (which would take down the banner too).
 *
 * Behavioural contract:
 *
 *   - `ELEVENLABS_API_KEY` unset → `{ success: true }` (signal-only; listener
 *     synthesizes via Keychain). Info-level log.
 *   - Voice id resolves to null (no project override + no env default) →
 *     `{ success: true }` (signal-only). Info-level log — this is an expected
 *     degradation, not an error; NO captureException.
 *   - Voice resolution itself throws (e.g. DB hiccup in project-voice lookup)
 *     → `{ success: true }` (signal-only). Warn-level log — a transient DB
 *     error must never kill TTS.
 *   - HTTP 4xx/5xx / network timeout during synth → `{ success: true }`
 *     (signal-only). Warn-level log — a flaky ElevenLabs endpoint must not
 *     spam Sentry on every notification; the Mac fallback handles it.
 *   - Synth success → persist mp3 to `~/.config/nexus/audio/<id>.mp3` via
 *     `writeAudio()`, base64-encode the bytes, return
 *     `{ success: true, audioBase64, voiceUsed }`.
 *
 * The ONLY path that returns `audioBase64` is the full happy path; every
 * other outcome degrades to signal-only `success: true`. This handler does
 * NOT return `success: false`.
 */
async function sendTtsNotification(
  notification: NotificationRow,
): Promise<ChannelResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    log.info(
      { notificationId: notification.id },
      "tts: ELEVENLABS_API_KEY unset — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }

  let voiceId: string | null;
  try {
    voiceId = await resolveVoiceId(notification);
  } catch (err) {
    // Voice resolution threw (e.g. DB hiccup in project-voice lookup).
    // Degrade to signal-only — a transient lookup error must never kill TTS.
    log.warn(
      {
        notificationId: notification.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "tts: voice id resolution threw — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }
  if (!voiceId) {
    // Expected degradation (no project override + ELEVENLABS_DEFAULT_VOICE_ID
    // unset), not an error. Emit signal-only so the Mac listener synthesizes
    // via Keychain. No captureException — this is a normal fallback.
    log.info(
      { notificationId: notification.id, project: notification.project },
      "tts: no voice id available — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }

  try {
    const mp3 = await synthesizeViaElevenLabs(notification, voiceId, apiKey);
    await writeAudio(notification.id, mp3);
    // Base64-encode for SSE transport. Buffer is available in both Bun and
    // Node runtimes via the global.
    const audioBase64 = Buffer.from(mp3).toString("base64");
    return { success: true, audioBase64, voiceUsed: voiceId };
  } catch (err) {
    // Synth HTTP/network error. Degrade to signal-only so the notification
    // still delivers (banner + listener-side synth) — a flaky ElevenLabs
    // endpoint must not kill TTS. Warn-only, no captureException (would spam
    // Sentry on every notification during an outage; the Mac fallback covers
    // synthesis).
    log.warn(
      {
        notificationId: notification.id,
        voiceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "tts: ElevenLabs synthesis failed — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }
}

/** Timeout in ms for a single channel handler invocation. */
const NOTIFICATION_TIMEOUT_MS = Number(process.env.NEXUS_NOTIFICATION_TIMEOUT_MS ?? 10_000);

/**
 * Per-channel structured result.
 *
 * After `swift-owns-elevenlabs-synth`, channels are signal-only: the agent
 * no longer produces audio bytes (the Mac listener synthesizes via
 * NexusShared.ElevenLabsClient + Keychain). The result is reduced to a
 * boolean success flag, but kept as an object so future channels can widen
 * it without churn at the call sites.
 */
export interface ChannelResult {
  success: boolean;
  /**
   * Base64-encoded MP3 produced by an in-channel synthesiser (TTS only).
   * Threaded through the manager onto `NotificationFired.audioBase64` so the
   * Mac listener can play the agent-synth output instead of doing its own
   * local synth round-trip.
   */
  audioBase64?: string;
  /** Voice id used by the TTS handler. Pairs with `audioBase64`. */
  voiceUsed?: string;
}

/** Channel handlers may return a bare boolean (legacy) or a structured result. */
type ChannelHandlerReturn = boolean | ChannelResult;

function normalizeResult(value: ChannelHandlerReturn): ChannelResult {
  if (typeof value === "boolean") return { success: value };
  return value;
}

/**
 * Wrap a channel handler call with a deadline. If the handler does not resolve
 * within NOTIFICATION_TIMEOUT_MS, the promise rejects with a TimeoutError and
 * Sentry captures the exception.
 */
async function withChannelTimeout(
  channel: NotificationChannel,
  notification: NotificationRow,
  handler: (n: NotificationRow) => Promise<ChannelHandlerReturn>,
): Promise<ChannelResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(
        `notification delivery timeout: ${channel} (notificationId=${notification.id})`,
      );
      captureException(err);
      reject(err);
    }, NOTIFICATION_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([handler(notification), timeoutPromise]);
    return normalizeResult(result);
  } finally {
    clearTimeout(timeoutId);
  }
}

const log = createLogger("agent:notifications:router");

/** Default routing rules when no project-specific rule matches. */
const DEFAULT_RULES: NotificationRule[] = [
  {
    channels: ["desktop"],
    meeting_behavior: "buffer",
  },
];

/** Project-specific routing rules (mutable for runtime configuration). */
let projectRules: NotificationRule[] = [];

/** Set routing rules (for configuration and testing). */
export function setRoutingRules(rules: NotificationRule[]): void {
  projectRules = rules;
}

/** Get current routing rules. */
export function getRoutingRules(): NotificationRule[] {
  return [...projectRules, ...DEFAULT_RULES];
}

/** Find the best matching rule for a notification.
 *
 * Precedence:
 *   1. Project-specific rule (projectRules with matching project)
 *   2. Wildcard rule (projectRules with no project)
 *   3. Caller's notification.channel (respect explicit channel request)
 *   4. DEFAULT_RULES (hardcoded fallback — desktop only)
 *
 * Fix 2026-04-24: Previously fell through to DEFAULT_RULES['desktop']
 * unconditionally, which meant every /notifications/send with a non-default
 * channel (tts, etc.) dispatched to the desktop handler. Now the
 * notification's own channel is honored when no rule matches.
 */
export function findMatchingRule(notification: NotificationRow): NotificationRule {
  // Try project-specific rule first
  if (notification.project) {
    const projectRule = projectRules.find((r) => r.project === notification.project);
    if (projectRule) return projectRule;
  }

  // Try wildcard rules (no project specified)
  const wildcardRule = projectRules.find((r) => !r.project);
  if (wildcardRule) return wildcardRule;

  // Respect caller's explicit channel request
  if (notification.channel) {
    return {
      channels: [notification.channel as NotificationChannel],
      meeting_behavior: "buffer",
    };
  }

  // Fall back to hardcoded default
  return DEFAULT_RULES[0]!;
}

/**
 * Channel dispatch map.
 *
 * Slack was removed by `remove-slack-channel` (spine-migration). Any caller
 * that still passes `channel: 'slack'` is surfaced (NOT silently dropped) by
 * `surfaceMissingHandler` below — see scenarios in
 * `openspec/changes/remove-slack-channel/specs/notification-store/spec.md`.
 */
const CHANNEL_HANDLERS: Record<
  NotificationChannel,
  (notification: NotificationRow) => Promise<ChannelHandlerReturn>
> = {
  desktop: sendDesktopNotification,
  tts: sendTtsNotification,
};

/**
 * Surface a routing request for a channel that has no registered handler.
 *
 * Previously this was a silent skip with only a warn log + breadcrumb. A
 * breadcrumb alone never produces a Sentry event — it only attaches context to
 * a LATER captured error — so a misconfigured channel (e.g. a caller still
 * passing the removed `slack` channel) vanished with no alert. We now:
 *   1. log at warn (operator-visible in the agent log), AND
 *   2. `captureException` on the existing Sentry path so the misroute surfaces
 *      as its own event, with a breadcrumb attached for context.
 *
 * Shared by both `routeNotification` (serial) and `routeNotificationParallel`
 * so the two dispatch paths cannot drift on how a missing handler is handled.
 */
function surfaceMissingHandler(
  channel: NotificationChannel,
  notificationId: string,
): void {
  log.warn({ channel, notificationId }, "No handler for channel");
  addBreadcrumb({
    category: "notification",
    level: "warning",
    message: "missing handler",
    data: { channel, notificationId },
  });
  captureException(
    new Error(
      `no notification channel handler for "${channel}" (notificationId=${notificationId})`,
    ),
  );
}

/**
 * Route a notification to the appropriate channels based on rules.
 * Returns an array of channel results (serial — preserved for backward compat).
 */
export async function routeNotification(
  notification: NotificationRow,
): Promise<Array<{ channel: NotificationChannel; success: boolean }>> {
  const rule = findMatchingRule(notification);
  const results: Array<{ channel: NotificationChannel; success: boolean }> = [];

  // Strip TTS for unspeakable bodies (e.g. raw file paths, ghosty mentions).
  // Other channels still receive the notification — the user wants to know it
  // happened, just not have it read aloud. Mirrors the socket dispatcher
  // guards so HTTP-path callers cannot bypass suppression.
  const unspeakable = isUnspeakable(notification.body ?? "");
  const channels = unspeakable
    ? rule.channels.filter((c) => c !== "tts")
    : rule.channels;
  if (unspeakable && rule.channels.includes("tts")) {
    log.info(
      { body: notification.body },
      "router: TTS suppressed for unspeakable body",
    );
  }

  for (const channel of channels) {
    const handler = CHANNEL_HANDLERS[channel];
    if (handler === undefined) {
      surfaceMissingHandler(channel, notification.id);
      continue;
    }
    const { success } = await withChannelTimeout(channel, notification, handler);
    results.push({ channel, success });
  }

  return results;
}

/** Per-channel delivery outcome surfaced to the manager. */
export interface DeliveredChannel {
  channel: NotificationChannel;
  /** Set by the TTS handler when agent-side synthesis succeeded. */
  audioBase64?: string;
  /** Voice id paired with `audioBase64`. */
  voiceUsed?: string;
}

/**
 * Route a notification to all matching channels in parallel (D4).
 *
 * Uses Promise.allSettled so a single failing channel does not block others.
 * Delivered channels carry per-channel metadata (e.g. TTS audio bytes) so the
 * manager can attach them to the lifecycle event.
 */
export async function routeNotificationParallel(
  notification: NotificationRow,
): Promise<{ delivered: DeliveredChannel[]; failed: string[] }> {
  const rule = findMatchingRule(notification);

  let knownChannels = rule.channels.filter((ch) => {
    if (CHANNEL_HANDLERS[ch] === undefined) {
      surfaceMissingHandler(ch, notification.id);
      return false;
    }
    return true;
  }) as NotificationChannel[];

  // Strip TTS for unspeakable bodies (e.g. raw file paths, ghosty mentions).
  // Mirrors the socket dispatcher guards so HTTP-path callers cannot bypass
  // suppression.
  if (isUnspeakable(notification.body ?? "")) {
    if (knownChannels.includes("tts")) {
      log.info(
        { body: notification.body },
        "router: TTS suppressed for unspeakable body",
      );
    }
    knownChannels = knownChannels.filter((c) => c !== "tts");
  }

  const settled = await Promise.allSettled(
    knownChannels.map((ch) => withChannelTimeout(ch, notification, CHANNEL_HANDLERS[ch]!)),
  );

  const delivered: DeliveredChannel[] = [];
  const failed: string[] = [];

  for (const [i, result] of settled.entries()) {
    const channelName = knownChannels[i]!;
    if (result.status === "fulfilled") {
      const value = result.value;
      if (value.success) {
        delivered.push({
          channel: channelName,
          audioBase64: value.audioBase64,
          voiceUsed: value.voiceUsed,
        });
      } else {
        // Handler returned `success: false` — treat as a soft failure.
        failed.push(channelName);
      }
    } else {
      // The handler rejected — either the channel timed out (a hung handler
      // tripped `withChannelTimeout`'s deadline) or it threw. Either way this
      // channel is marked failed and pushed to `failed[]`; because we await a
      // single `Promise.allSettled`, the rejection of ONE channel never blocks
      // delivery on the others. The timeout itself already called
      // `captureException` inside `withChannelTimeout`.
      failed.push(channelName);
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      const timedOut = reason.includes("notification delivery timeout");
      log.error(
        { channel: channelName, notificationId: notification.id, err: reason, timedOut },
        timedOut
          ? "channel delivery timed out — marked failed (other channels unaffected)"
          : "channel delivery failed",
      );
    }
  }

  return { delivered, failed };
}

// ---------------------------------------------------------------------------
// Presence-aware routing (context-aware-routing, Phase 1)
// ---------------------------------------------------------------------------

/**
 * Map a rules-engine `Action` to the concrete `NotificationChannel[]` the
 * existing fan-out understands. Phase 1 keeps `NotificationChannel` as
 * `desktop | tts`: `banner` -> `desktop`, `tts` -> `tts`. Targets / digest /
 * hold are handled by the manager (held-queue), not the channel layer.
 */
export function actionToChannels(action: Action): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (action.banner) channels.push("desktop");
  if (action.tts) channels.push("tts");
  return channels;
}

/**
 * The presence-routing decision for one notification.
 *
 * `hold` is set when the winning Action carries a `holdUntil` — the manager
 * routes it to the durable held queue instead of delivering now. `channels` is
 * the immediate fan-out set (empty when held or digest-only). `action` is the
 * full winning Action for downstream metadata (deliverTo, redact, etc.).
 */
export interface PresenceRouteDecision {
  hold: boolean;
  holdUntil: string | null;
  channels: NotificationChannel[];
  action: Action;
}

/**
 * Decide how to route a notification under the presence-aware engine.
 *
 * HARD PARITY CONTRACT: when `presenceAwareRouting` is `false` (the default),
 * this function does NOT consult the rules engine or the vector at all — the
 * caller MUST fall back to the byte-identical legacy `routeNotificationParallel`
 * path. This function only produces a decision when the flag is ON; it returns
 * `null` when the flag is off to make the "use the legacy path" branch explicit
 * and untestably-divergent from today's behaviour.
 */
export function decidePresenceRoute(
  presenceAwareRouting: boolean,
  vector: PresenceVector,
): PresenceRouteDecision | null {
  if (!presenceAwareRouting) return null;

  const action = evaluateRules(vector);
  const channels = actionToChannels(action);
  const hold = action.holdUntil !== null;

  log.debug(
    { hold, holdUntil: action.holdUntil, channels, deliverTo: action.deliverTo },
    "router: presence-aware decision",
  );

  return { hold, holdUntil: action.holdUntil, channels, action };
}
