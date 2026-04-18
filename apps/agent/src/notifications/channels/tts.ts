import { logger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { captureException } from "@sentry/node";
import type { NotificationRow } from "../buffer";

/**
 * TTS notification channel via ElevenLabs API.
 *
 * When ELEVENLABS_API_KEY is not set, falls back to console logging.
 */
export async function sendTtsNotification(notification: NotificationRow): Promise<boolean> {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    logger.info({ id: notification.id, body: notification.body }, "tts notification (stub — no ELEVENLABS_API_KEY)");
    return true;
  }

  try {
    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
    const res = await fetchWithTimeout(
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
        timeout: 5_000,
      },
    );

    if (!res.ok) {
      const err = new Error(`TTS API error: HTTP ${res.status}`);
      captureException(err);
      logger.error({ id: notification.id, status: res.status }, "tts API error");
      throw err;
    }

    logger.info({ id: notification.id }, "tts notification sent");
    return true;
  } catch (err) {
    captureException(err);
    logger.error({
      id: notification.id,
      error: err instanceof Error ? err.message : String(err),
    }, "tts notification failed");
    throw err;
  }
}
