import type { NotificationChannel, NotificationRule } from "@nexus/core";
import type { NotificationRow } from "./buffer";
import { sendDesktopNotification } from "./channels/desktop";
import { sendTtsNotification } from "./channels/tts";
import { sendSlackNotification } from "./channels/slack";

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
 * Returns an array of channel results.
 */
export async function routeNotification(
  notification: NotificationRow,
): Promise<Array<{ channel: NotificationChannel; success: boolean }>> {
  const rule = findMatchingRule(notification);
  const results: Array<{ channel: NotificationChannel; success: boolean }> = [];

  for (const channel of rule.channels) {
    const handler = CHANNEL_HANDLERS[channel];
    if (handler) {
      const success = await handler(notification);
      results.push({ channel, success });
    }
  }

  return results;
}
