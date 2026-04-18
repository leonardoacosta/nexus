/**
 * TTS notification dispatch for the spec-watcher service.
 */

import { createLogger } from "@nexus/core/node";
import { sendTtsNotification } from "../../notifications/channels/tts";

const log = createLogger("agent:spec-watcher");

/**
 * Send a combined TTS notification for spec events.
 * Creates a minimal NotificationRow stub for the TTS channel.
 */
export async function sendSpecTtsNotification(message: string): Promise<void> {
  try {
    const stubRow = {
      id: `spec-watcher-${Date.now()}`,
      title: "Spec Watcher",
      body: message,
      channel: "tts" as const,
      priority: "normal" as const,
      status: "queued" as const,
      project: null,
      agentId: null,
      createdAt: new Date(),
      sentAt: null,
    };
    await sendTtsNotification(stubRow);
  } catch (err) {
    log.warn({ error: err }, "Failed to send spec-watcher TTS notification");
  }
}
