import { logger } from "@nexus/core/node";
import type { NotificationRow } from "../buffer";

/**
 * TTS notification channel — signal-only after `swift-owns-elevenlabs-synth`.
 *
 * Per spec, ElevenLabs synthesis moved to the Mac side. The agent no longer
 * owns the API key, no longer issues HTTP calls to ElevenLabs, and no longer
 * returns audioBase64 bytes. It emits a `NotificationFired` lifecycle event
 * with the text payload; the Mac listener (nexus-mac) reads the event,
 * pulls the key + voice from Keychain, synthesizes via
 * `NexusShared.ElevenLabsClient`, and plays via AVAudioPlayer with the user-
 * configured ducking mode.
 *
 * This file is now an intentionally narrow shim. The full architectural
 * rationale lives in:
 *   openspec/changes/swift-owns-elevenlabs-synth/proposal.md
 *
 * Historical note: this module used to resolve a DB-encrypted key, call
 * https://api.elevenlabs.io/v1/text-to-speech/{voice}, base64-encode the
 * mp3 bytes, and return them so the listener could play. That coupling
 * forced the agent to be online + un-rate-limited every time we wanted a
 * "ding"; moving the synth client to the Mac side removes that dependency.
 */

export interface TtsResult {
  /** Always true. The channel never blocks a notification — playback is the listener's job. */
  success: boolean;
}

/** Optional dependency bundle. Kept for back-compat with test callers. */
export interface TtsContext {
  // intentionally empty after the synth migration; preserved so the
  // notification router signature stays stable.
}

/**
 * Cycle-safe key scrubber. Kept here even though the channel no longer
 * sends xi-api-key headers, because legacy callers still import and use
 * it (tests, agent error handlers, etc).
 */
export function scrubFetchError(err: unknown): unknown {
  const seen = new WeakSet<object>();
  function walk(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: value.message,
      };
      if (value.stack) out.stack = value.stack;
      for (const [k, v] of Object.entries(value)) {
        if (/^xi-api-key$/i.test(k)) continue;
        out[k] = walk(v);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^xi-api-key$/i.test(k)) continue;
      out[k] = walk(v);
    }
    return out;
  }
  return walk(err);
}

export async function sendTtsNotification(
  notification: NotificationRow,
  _context?: TtsContext,
): Promise<TtsResult> {
  const text = notification.project
    ? `${notification.project}: ${notification.body}`
    : notification.body;
  logger.info(
    { id: notification.id, body: text },
    "tts notification accepted (signal-only — Mac listener synthesizes)",
  );
  return { success: true };
}
