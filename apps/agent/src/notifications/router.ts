import type { NotificationChannel, NotificationRule } from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import { captureException, addBreadcrumb } from "@sentry/node";
import type { NotificationRow } from "./buffer";
import { sendDesktopNotification } from "./channels/desktop";
import { sendTtsNotification } from "./channels/tts";
import { sendSlackNotification } from "./channels/slack";

/** Timeout in ms for a single channel handler invocation. */
const NOTIFICATION_TIMEOUT_MS = Number(process.env.NEXUS_NOTIFICATION_TIMEOUT_MS ?? 10_000);

/**
 * Per-channel structured result.
 *
 * Channels that produce additional metadata (e.g. TTS returns base64 mp3
 * bytes alongside the success flag) widen this with optional fields. The
 * manager threads these fields onto the `NotificationFired` lifecycle event
 * so SSE listeners can act on them.
 */
export interface ChannelResult {
  success: boolean;
  /** Base64-encoded mp3 bytes when the TTS channel synthesized audio. */
  audioBase64?: string;
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
 * unconditionally, which meant every /notifications/send with
 * channel='tts' or channel='slack' dispatched to the desktop handler.
 * Now the notification's own channel is honored when no rule matches.
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

/** Channel dispatch map. */
const CHANNEL_HANDLERS: Record<
  NotificationChannel,
  (notification: NotificationRow) => Promise<ChannelHandlerReturn>
> = {
  desktop: sendDesktopNotification,
  tts: sendTtsNotification,
  slack: sendSlackNotification,
};

/**
 * Route a notification to the appropriate channels based on rules.
 * Returns an array of channel results (serial — preserved for backward compat).
 */
export async function routeNotification(
  notification: NotificationRow,
): Promise<Array<{ channel: NotificationChannel; success: boolean }>> {
  const rule = findMatchingRule(notification);
  const results: Array<{ channel: NotificationChannel; success: boolean }> = [];

  for (const channel of rule.channels) {
    const handler = CHANNEL_HANDLERS[channel];
    if (handler === undefined) {
      log.warn({ channel, notificationId: notification.id }, "No handler for channel");
      addBreadcrumb({
        category: "notification",
        level: "warning",
        message: "missing handler",
        data: { channel, notificationId: notification.id },
      });
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
  /** Audio bytes (base64) when the channel produced them — TTS only. */
  audioBase64?: string;
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

  const knownChannels = rule.channels.filter((ch) => {
    if (CHANNEL_HANDLERS[ch] === undefined) {
      log.warn({ channel: ch, notificationId: notification.id }, "No handler for channel");
      addBreadcrumb({
        category: "notification",
        level: "warning",
        message: "missing handler",
        data: { channel: ch, notificationId: notification.id },
      });
      return false;
    }
    return true;
  }) as NotificationChannel[];

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
        delivered.push({ channel: channelName, audioBase64: value.audioBase64 });
      } else {
        // Handler returned `success: false` — treat as a soft failure.
        failed.push(channelName);
      }
    } else {
      failed.push(channelName);
      log.error(
        { channel: channelName, notificationId: notification.id, err: result.reason },
        "channel delivery failed",
      );
    }
  }

  return { delivered, failed };
}
