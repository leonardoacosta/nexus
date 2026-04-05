import { logger } from "@nexus/core";
import { captureException } from "@sentry/node";
import type { NotificationRow } from "../buffer";

/**
 * Slack webhook notification channel.
 *
 * Requires SLACK_WEBHOOK_URL environment variable.
 */
export async function sendSlackNotification(notification: NotificationRow): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    logger.info({ id: notification.id, title: notification.title }, "slack notification (stub — no SLACK_WEBHOOK_URL)");
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
      const err = new Error(`Slack webhook error: HTTP ${res.status}`);
      captureException(err);
      logger.error({ id: notification.id, status: res.status }, "slack webhook error");
      throw err;
    }

    logger.info({ id: notification.id }, "slack notification sent");
    return true;
  } catch (err) {
    captureException(err);
    logger.error({
      id: notification.id,
      error: err instanceof Error ? err.message : String(err),
    }, "slack notification failed");
    throw err;
  }
}
