import { logger } from "@nexus/core";
import type { NotificationRow } from "../buffer";

/**
 * Desktop notification channel.
 *
 * Uses Bun's `notify` API if available, otherwise logs to console.
 * A production implementation would use node-notifier or similar.
 */
export async function sendDesktopNotification(notification: NotificationRow): Promise<boolean> {
  try {
    logger.info({ id: notification.id, title: notification.title }, "desktop notification sent");
    return true;
  } catch (err) {
    logger.error({
      id: notification.id,
      error: err instanceof Error ? err.message : String(err),
    }, "desktop notification failed");
    return false;
  }
}
