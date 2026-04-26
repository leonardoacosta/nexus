import { logger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { captureException } from "@sentry/node";
import type { NotificationRow } from "../buffer";

/**
 * TTS notification channel — agent synthesizes via ElevenLabs, listener plays.
 *
 * Architecture (2026-04-25): The agent is the sole holder of
 * ELEVENLABS_API_KEY and the sole point of quota accounting. When the key
 * is set, this channel POSTs the project-prefixed text to the ElevenLabs
 * text-to-speech endpoint, captures the resulting mp3 bytes, and surfaces
 * them base64-encoded on the structured return so the manager can attach
 * them to the `NotificationFired` lifecycle event.
 *
 * The agent MUST NOT play audio locally — homelab is headless. Playback
 * is the listener's responsibility (Mac-side `nexus-notifier` daemon
 * subscribes to /events/stream and pipes the bytes into `afplay`).
 *
 * When ELEVENLABS_API_KEY is unset, the channel is signal-only: it marks
 * the notification as delivered and returns `audioBase64: undefined` so
 * `NotificationFired` still fires for any listener that owns its own TTS
 * (Slack bridge, mobile AVSpeechSynthesizer, etc.).
 *
 * When the key IS set but ElevenLabs rejects it (HTTP 4xx/5xx) or the
 * request fails (network/timeout), the channel ALSO falls back to
 * signal-only success. The synthesized mp3 is an enrichment, not a
 * hard requirement — the listener can always use local TTS (Mac `say`,
 * etc.). Returning failure here would suppress `NotificationFired`
 * entirely and silence every downstream consumer.
 */

export interface TtsResult {
  /** Whether the channel accepted the notification for delivery. */
  success: boolean;
  /** Base64-encoded mp3 bytes from ElevenLabs (absent when key is unset). */
  audioBase64?: string;
}

export async function sendTtsNotification(
  notification: NotificationRow,
): Promise<TtsResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const text = notification.project
    ? `${notification.project}: ${notification.body}`
    : notification.body;

  // No API key: signal-only branch. Return success without audio so the
  // lifecycle event still fires for non-audio listeners.
  if (!apiKey) {
    logger.info(
      { id: notification.id, body: text },
      "tts notification accepted (signal-only — no ELEVENLABS_API_KEY)",
    );
    return { success: true };
  }

  // Key set: synthesize via ElevenLabs and return the mp3 bytes. On any
  // failure (4xx/5xx, network, timeout) we degrade to signal-only success
  // so `NotificationFired` still fires and the listener can fall back to
  // local TTS. ElevenLabs is enrichment, not a hard requirement.
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
      logger.warn(
        { id: notification.id, status: res.status },
        "tts API error — falling back to signal-only (listener will use local TTS)",
      );
      return { success: true };
    }

    const buf = await res.arrayBuffer();
    const audioBase64 = Buffer.from(buf).toString("base64");

    logger.info(
      { id: notification.id, bytes: buf.byteLength },
      "tts notification synthesized via ElevenLabs",
    );
    return { success: true, audioBase64 };
  } catch (err) {
    captureException(err);
    logger.warn(
      {
        id: notification.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "tts synthesis failed — falling back to signal-only (listener will use local TTS)",
    );
    return { success: true };
  }
}
