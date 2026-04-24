import { logger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { captureException } from "@sentry/node";
import type { NotificationRow } from "../buffer";

/**
 * TTS notification channel — signal-only on the agent side.
 *
 * Architecture (2026-04-24): TTS delivery happens client-side, not here.
 * The Mac-side nexus-notifier daemon subscribes to the lifecycle bus SSE
 * stream at /events/stream, filters for NotificationFired events with
 * channel="tts", and invokes the local `say` command. The agent's job is
 * just to mark the notification as delivered so NotificationFired emits.
 *
 * Optional legacy path: when NEXUS_TTS_USE_ELEVENLABS=1 AND
 * ELEVENLABS_API_KEY is set, the agent also calls the ElevenLabs API as
 * a fallback for headless hosts without a Mac listener. Defaults to off
 * to avoid burning ElevenLabs quota on content the Mac will re-speak
 * anyway.
 */
export async function sendTtsNotification(notification: NotificationRow): Promise<boolean> {
  const useElevenLabs = process.env.NEXUS_TTS_USE_ELEVENLABS === "1";
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const text = notification.project
    ? `${notification.project}: ${notification.body}`
    : notification.body;

  // Default path: signal-only. Delivery = "accepted for Mac-side dispatch".
  if (!useElevenLabs || !apiKey) {
    logger.info(
      { id: notification.id, body: text },
      "tts notification accepted (Mac-side delivery via NotificationFired)",
    );
    return true;
  }

  // Legacy path: agent-side ElevenLabs delivery (opt-in).
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
          text,
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

    logger.info({ id: notification.id }, "tts notification sent via ElevenLabs");
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
