import type {
  Action,
  NotificationChannel,
  NotificationRule,
  PresenceVector,
} from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import { evaluateRules, isVectorAllUnknown } from "./rules-engine";
import type { NotificationRow } from "./buffer";
import { isUnspeakable } from "./speakability";
import {
  sendTtsNotification,
  setTtsDbHandle,
  resolveElevenLabsCredential,
  type ChannelResult,
} from "./channels/tts";
import { sendTelegramNotification } from "./channels/telegram";

// Re-export the channel-owned credential surface so external callers
// (`server.ts`, `tts-credential-resolve.test.ts`) keep importing it from
// `./notifications/router` unchanged after the extraction
// (extract-notification-channels).
export { setTtsDbHandle, resolveElevenLabsCredential };
export type { ResolvedElevenLabsCredential } from "./channels/tts";

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

/** Timeout in ms for a single channel handler invocation. */
const NOTIFICATION_TIMEOUT_MS = Number(process.env.NEXUS_NOTIFICATION_TIMEOUT_MS ?? 10_000);

/** Channel handlers may return a bare boolean (legacy) or a structured result. */
type ChannelHandlerReturn = boolean | ChannelResult;

function normalizeResult(value: ChannelHandlerReturn): ChannelResult {
  if (typeof value === "boolean") return { success: value };
  return value;
}

/**
 * Wrap a channel handler call with a deadline. If the handler does not resolve
 * within NOTIFICATION_TIMEOUT_MS, the promise rejects with a TimeoutError and
 * the error is logged (pino's OTel mixin — packages/core/src/logger.ts —
 * attaches the active trace/span id, so this correlates the same way a
 * Sentry captureException event used to).
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
      log.error(
        { err, channel, notificationId: notification.id },
        "notification delivery timeout",
      );
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
  ropen: signalOnlyChannel,
  telegram: sendTelegramNotification,
};

/**
 * Surface a routing request for a channel that has no registered handler.
 *
 * Previously this was a silent skip with only a warn log. A breadcrumb alone
 * never produced a Sentry event — it only attached context to a LATER
 * captured error — so a misconfigured channel (e.g. a caller still passing
 * the removed `slack` channel) vanished with no alert. We now:
 *   1. log at warn (operator-visible in the agent log, carrying the same
 *      channel/notificationId context the breadcrumb used to attach), AND
 *   2. log at error with the constructed Error attached so the misroute
 *      surfaces via OTel/pino error correlation the same way a Sentry
 *      captureException event used to (pino's OTel mixin attaches the
 *      active trace/span id — packages/core/src/logger.ts).
 *
 * Used by `routeNotificationParallel` (the single dispatch path) so a
 * misrouted channel is surfaced consistently.
 */
function surfaceMissingHandler(
  channel: NotificationChannel,
  notificationId: string,
): void {
  log.warn({ channel, notificationId }, "No handler for channel");
  const err = new Error(
    `no notification channel handler for "${channel}" (notificationId=${notificationId})`,
  );
  log.error(
    { err, channel, notificationId },
    "missing notification channel handler",
  );
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
      // delivery on the others. The timeout itself already logged at error
      // level inside `withChannelTimeout`.
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
 *
 * ALL-UNKNOWN GUARD: even when the flag is ON, a vector with NO known fields
 * (every `PresenceField.confidence === "unknown"`) also returns `null` and
 * falls back to the legacy path. On a headless agent (no Mac sensor, no phone
 * poll) every field is `unknown`, so `evaluateRules` would otherwise hit its
 * terminal digest fallback (dashboard-only, no banner/TTS) and SILENCE the
 * notification — a regression vs today's loud legacy banner+TTS. "I have no
 * idea where you are" must behave exactly as today, not suppress to a digest.
 */
export function decidePresenceRoute(
  presenceAwareRouting: boolean,
  vector: PresenceVector,
): PresenceRouteDecision | null {
  if (!presenceAwareRouting) return null;
  if (isVectorAllUnknown(vector)) return null;

  const action = evaluateRules(vector);
  const channels = actionToChannels(action);
  const hold = action.holdUntil !== null;

  log.debug(
    { hold, holdUntil: action.holdUntil, channels, deliverTo: action.deliverTo },
    "router: presence-aware decision",
  );

  return { hold, holdUntil: action.holdUntil, channels, action };
}
