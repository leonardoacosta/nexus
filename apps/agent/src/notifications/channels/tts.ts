import { logger, getAgentId } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { captureException } from "@sentry/node";
import { eq } from "drizzle-orm";
import type { Db } from "@nexus/db";
import { elevenlabsCredentials } from "@nexus/db";
import type { NotificationRow } from "../buffer";
import { decrypt } from "../../credentials/encryption";
import { getElevenlabsEncryptionKey } from "../../routes/elevenlabs-credentials";

/**
 * TTS notification channel — agent synthesizes via ElevenLabs, listener plays.
 *
 * Architecture (2026-04-26): The agent prefers a per-agent DB row in
 * `elevenlabs_credentials` (encrypted at rest) over `process.env`. Order of
 * resolution on every dispatch:
 *
 *   1. DB row for this agent (decrypted on-the-fly, no in-memory cache)
 *   2. `process.env.ELEVENLABS_API_KEY` (legacy / unmigrated agents)
 *   3. Signal-only mode — no HTTP call, return success without audio
 *
 * The DB read is intentionally re-issued on every dispatch so a dashboard
 * PATCH propagates within a single dispatch cycle. There is no in-memory
 * cache of the decrypted key (see design.md "Why no cache").
 *
 * The agent MUST NOT play audio locally — homelab is headless. Playback is
 * the listener's responsibility (Mac-side `nexus-notifier` daemon).
 *
 * Graceful fallback: when the upstream API rejects the call (4xx/5xx) or
 * the network throws, the channel returns `{ success: true }` with no
 * audioBase64 so `NotificationFired` still fires and the Mac listener can
 * fall back to local `say(1)`. Suppressing the lifecycle event would
 * silence every downstream consumer over what is fundamentally an
 * enrichment failure.
 */

export interface TtsResult {
  /** Whether the channel accepted the notification for delivery. */
  success: boolean;
  /** Base64-encoded mp3 bytes from ElevenLabs (absent when key is unset). */
  audioBase64?: string;
}

/**
 * Optional dependency bundle threaded by the notifications manager so the
 * channel can read the per-agent ElevenLabs row before falling back to env.
 */
export interface TtsContext {
  db?: Db;
}

/**
 * Module-level db ref used by the production channel-handler dispatch
 * (which doesn't accept a per-call context). The notifications manager
 * installs this in its constructor; tests bypass it by passing `{ db }`
 * directly to `sendTtsNotification`.
 */
let ambientDb: Db | undefined;

/** Install the ambient db ref (called once by the manager). */
export function setTtsDb(db: Db | undefined): void {
  ambientDb = db;
}

/** Reset (testing only). */
export function resetTtsDb(): void {
  ambientDb = undefined;
}

interface ResolvedCredential {
  apiKey: string;
  voiceId: string | null;
}

/**
 * Resolve the ElevenLabs credential for this dispatch.
 *
 * Returns `null` when neither DB nor env supplies a key — caller should
 * stay in signal-only mode. Never throws — DB-read failures fall back to
 * env. Encryption-key absence is treated like a missing row (we don't
 * have a way to surface a 400 from inside the channel).
 */
async function resolveCredential(
  db: Db | undefined,
): Promise<ResolvedCredential | null> {
  if (db) {
    try {
      const agentId = getAgentId();
      const row = await db.query.elevenlabsCredentials.findFirst({
        where: eq(elevenlabsCredentials.agentId, agentId),
      });
      if (row && row.valueEncrypted) {
        const key = getElevenlabsEncryptionKey();
        if (key) {
          try {
            const apiKey = decrypt(row.valueEncrypted, key);
            return { apiKey, voiceId: row.voiceId };
          } catch (err) {
            logger.warn(
              { err, agentId },
              "tts: decrypt failed for stored key — falling back to env",
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err },
        "tts: DB lookup failed — falling back to env",
      );
    }
  }

  const envKey = process.env.ELEVENLABS_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      voiceId: process.env.ELEVENLABS_VOICE_ID ?? null,
    };
  }
  return null;
}

export async function sendTtsNotification(
  notification: NotificationRow,
  context?: TtsContext,
): Promise<TtsResult> {
  const text = notification.project
    ? `${notification.project}: ${notification.body}`
    : notification.body;

  const credential = await resolveCredential(context?.db ?? ambientDb);

  // Neither DB row nor env: signal-only branch.
  if (!credential) {
    logger.info(
      { id: notification.id, body: text },
      "tts notification accepted (signal-only — no key in DB or env)",
    );
    return { success: true };
  }

  // Key resolved: synthesize via ElevenLabs and return the mp3 bytes. On any
  // failure (4xx/5xx, network, timeout) we degrade to signal-only success
  // so `NotificationFired` still fires and the listener can fall back to
  // local TTS. ElevenLabs is enrichment, not a hard requirement.
  try {
    const voiceId = credential.voiceId ?? "21m00Tcm4TlvDq8ikWAM";
    const res = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": credential.apiKey,
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
