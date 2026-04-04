import { logger } from "@nexus/core";
import type { NotificationRow } from "../buffer";

/**
 * TTS notification channel via ElevenLabs API.
 *
 * When ELEVENLABS_API_KEY is not set, falls back to console logging.
 */
export async function sendTtsNotification(notification: NotificationRow): Promise<boolean> {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    logger.info("tts notification (stub — no ELEVENLABS_API_KEY)", {
      id: notification.id,
      body: notification.body,
    });
    return true;
  }

  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: notification.body,
          model_id: "eleven_monolingual_v1",
        }),
      },
    );

    if (!res.ok) {
      logger.error("tts API error", {
        id: notification.id,
        status: res.status,
      });
      return false;
    }

    logger.info("tts notification sent", { id: notification.id });
    return true;
  } catch (err) {
    logger.error("tts notification failed", {
      id: notification.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
