import { logger } from "@nexus/core";
import type { NotificationRow } from "../buffer";

/**
 * Slack webhook notification channel.
 *
 * Requires SLACK_WEBHOOK_URL environment variable.
 */
export async function sendSlackNotification(notification: NotificationRow): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    logger.info("slack notification (stub — no SLACK_WEBHOOK_URL)", {
      id: notification.id,
      title: notification.title,
    });
    return true;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `*${notification.title}*\n${notification.body}`,
        ...(notification.project && {
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${notification.title}*\n${notification.body}\n_Project: ${notification.project}_`,
              },
            },
          ],
        }),
      }),
    });

    if (!res.ok) {
      logger.error("slack webhook error", {
        id: notification.id,
        status: res.status,
      });
      return false;
    }

    logger.info("slack notification sent", { id: notification.id });
    return true;
  } catch (err) {
    logger.error("slack notification failed", {
      id: notification.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
