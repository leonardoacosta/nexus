import type { NotificationChannel, NotificationRule } from "@nexus/core";
import { createLogger } from "@nexus/core/node";
import type { NotificationRow } from "./buffer";
import { sendDesktopNotification } from "./channels/desktop";
import { sendTtsNotification } from "./channels/tts";
import { sendSlackNotification } from "./channels/slack";

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

/** Find the best matching rule for a notification. */
export function findMatchingRule(notification: NotificationRow): NotificationRule {
  // Try project-specific rule first
  if (notification.project) {
    const projectRule = projectRules.find((r) => r.project === notification.project);
    if (projectRule) return projectRule;
  }

  // Try wildcard rules (no project specified)
  const wildcardRule = projectRules.find((r) => !r.project);
  if (wildcardRule) return wildcardRule;

  // Fall back to default
  return DEFAULT_RULES[0]!;
}

/** Channel dispatch map. */
const CHANNEL_HANDLERS: Record<
  NotificationChannel,
  (notification: NotificationRow) => Promise<boolean>
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
      log.warn({ channel, notificationId: notification.id }, "unknown notification channel");
      continue;
    }
    const success = await handler(notification);
    results.push({ channel, success });
  }

  return results;
}

/**
 * Route a notification to all matching channels in parallel (D4).
 *
 * Uses Promise.allSettled so a single failing channel does not block others.
 * Returns separate lists of delivered and failed channel names.
 */
export async function routeNotificationParallel(
  notification: NotificationRow,
): Promise<{ delivered: string[]; failed: string[] }> {
  const rule = findMatchingRule(notification);

  const knownChannels = rule.channels.filter((ch) => {
    if (CHANNEL_HANDLERS[ch] === undefined) {
      log.warn({ channel: ch, notificationId: notification.id }, "unknown notification channel");
      return false;
    }
    return true;
  }) as NotificationChannel[];

  const settled = await Promise.allSettled(
    knownChannels.map((ch) => CHANNEL_HANDLERS[ch]!(notification)),
  );

  const delivered: string[] = [];
  const failed: string[] = [];

  for (const [i, result] of settled.entries()) {
    const channelName = knownChannels[i]!;
    if (result.status === "fulfilled") {
      delivered.push(channelName);
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
