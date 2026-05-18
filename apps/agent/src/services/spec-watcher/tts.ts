/**
 * TTS notification dispatch for the spec-watcher service.
 *
 * After `remove-notification-channels` (P4): the agent no longer owns
 * synthesis. This helper now logs the intent and emits a signal-only
 * lifecycle event — the Mac listener consumes it and synthesizes.
 */

import { createLogger } from "@nexus/core/node";
import { lifecycleBus } from "../lifecycle-bus";

const log = createLogger("agent:spec-watcher");

/**
 * Send a combined TTS notification for spec events.
 *
 * The agent-side path is signal-only post-P4.5. We emit a
 * `NotificationFired` lifecycle event with channel="tts"; the Mac listener
 * picks it up and synthesizes via NexusShared.ElevenLabsClient.
 */
export async function sendSpecTtsNotification(message: string): Promise<void> {
  try {
    lifecycleBus.emit("NotificationFired", {
      id: `spec-watcher-${Date.now()}`,
      title: "Spec Watcher",
      body: message,
      channel: "tts",
      message,
    });
    log.info({ body: message }, "spec-watcher TTS signal emitted");
  } catch (err) {
    log.warn({ error: err }, "Failed to emit spec-watcher TTS notification");
  }
}
