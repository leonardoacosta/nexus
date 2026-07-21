/**
 * TTS / ElevenLabs channel transport.
 *
 * Extracted from `router.ts` by `extract-notification-channels` (GOD-04):
 * the ElevenLabs synthesis handler, its credential resolution, and the shared
 * DB db-handle live here so `router.ts` holds only routing policy. Behavior is
 * unchanged — same credential precedence, same fail-open degradation, same
 * re-query-per-dispatch (no cache).
 *
 * Also home to:
 *  - the shared notifications DB handle (`setTtsDbHandle` / `getChannelDbHandle`),
 *    installed once at agent boot and used by both TTS and Telegram;
 *  - `decryptStoredCredential`, the shared DB-row -> load-key -> decrypt ->
 *    warn-fallback scaffold both channels use (was duplicated inline);
 *  - the `ChannelResult` type (moved from router.ts so the channel modules and
 *    router share one definition without a router->channel->router cycle).
 */

import { createLogger, getAgentId } from "@nexus/core/node";
import { fetchWithTimeout, parseQualifiedVoice } from "@nexus/core";
import type { Db } from "@nexus/db";
import { projectVoiceOverrides, elevenlabsCredentials } from "@nexus/db";
import { eq } from "drizzle-orm";
import type { NotificationRow } from "../buffer";
import { stripBeadIds } from "../speakability";
import { writeAudio } from "../audio-store";
import { decrypt, tryLoadEncryptionKey } from "../../credentials/encryption";

const log = createLogger("agent:notifications:channels:tts");

/** Logger shape shared by the channel modules (pino child from createLogger). */
type ChannelLogger = ReturnType<typeof createLogger>;

/**
 * Per-channel structured result.
 *
 * After `swift-owns-elevenlabs-synth`, channels are signal-only: the agent
 * no longer produces audio bytes (the Mac listener synthesizes via
 * NexusShared.ElevenLabsClient + Keychain). The result is reduced to a
 * boolean success flag, but kept as an object so future channels can widen
 * it without churn at the call sites.
 */
export interface ChannelResult {
  success: boolean;
  /**
   * Base64-encoded MP3 produced by an in-channel synthesiser (TTS only).
   * Threaded through the manager onto `NotificationFired.audioBase64` so the
   * Mac listener can play the agent-synth output instead of doing its own
   * local synth round-trip.
   */
  audioBase64?: string;
  /** Voice id used by the TTS handler. Pairs with `audioBase64`. */
  voiceUsed?: string;
}

// ---------------------------------------------------------------------------
// Shared notifications DB handle
// ---------------------------------------------------------------------------

/**
 * Per-call DB handle for the credential-backed channels (TTS + Telegram). Set
 * at agent boot via `setTtsDbHandle(db)`. Module-level (not injected via call
 * sites) because `CHANNEL_HANDLERS` is keyed by channel name and the handler
 * signature cannot grow without changing every caller; the manager already
 * passes each NotificationRow individually so DB injection at boot keeps the
 * dispatch arrow narrow.
 */
let ttsDbHandle: Db | null = null;

/** Install the DB handle the credential-backed channels use. */
export function setTtsDbHandle(db: Db | null): void {
  ttsDbHandle = db;
}

/** The shared notifications DB handle (used by the Telegram channel too). */
export function getChannelDbHandle(): Db | null {
  return ttsDbHandle;
}

// ---------------------------------------------------------------------------
// Shared encrypted-credential resolver
// ---------------------------------------------------------------------------

/**
 * Shared DB-row -> load-key -> decrypt -> warn-fallback scaffold used by both
 * the TTS (ElevenLabs) and Telegram credential lookups.
 *
 * Given a DB row's `value_encrypted`, load the local encryption key and
 * decrypt it. Returns the plaintext on success, or `null` when there is no
 * value, no encryption key (silent — an unmigrated agent has none), or the
 * decrypt itself fails (warn-logged via the caller's own logger + message, so
 * each channel keeps its exact log text). Callers fall back to their env var
 * on `null` — credential resolution must never hard-fail.
 */
export function decryptStoredCredential(
  valueEncrypted: string | null | undefined,
  logger: ChannelLogger,
  decryptFailureWarn: string,
): string | null {
  if (!valueEncrypted) return null;
  const key = tryLoadEncryptionKey();
  if (!key) return null;
  try {
    return decrypt(valueEncrypted, key);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      decryptFailureWarn,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs credential + voice resolution
// ---------------------------------------------------------------------------

/** ElevenLabs default voice id — fallback when no per-project override is set. */
function defaultVoiceId(): string | null {
  const v = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  return v && v.length > 0 ? v : null;
}

/** Resolved ElevenLabs credential — api key plus its optional voice id. */
export interface ResolvedElevenLabsCredential {
  apiKey: string;
  voiceId: string | null;
}

/**
 * Resolve the ElevenLabs API key (+ voice id) for the LOCAL agent.
 *
 * Precedence (add-elevenlabs-credential):
 *   1. Encrypted `elevenlabs_credentials` DB row for this agent — decrypted
 *      fresh on every call (NO in-memory cache) so a dashboard key rotation
 *      takes effect on the very next dispatch without an agent restart.
 *   2. `ELEVENLABS_API_KEY` env var (legacy / unmigrated agents).
 * Returns `null` when neither yields a key → caller stays signal-only.
 *
 * A DB error or a decrypt failure is non-fatal: it logs a warning and falls
 * through to the env var. TTS must never hard-fail on a credential lookup.
 */
export async function resolveElevenLabsCredential(
  db: Db | null = ttsDbHandle,
): Promise<ResolvedElevenLabsCredential | null> {
  if (db) {
    try {
      const row = await db.query.elevenlabsCredentials.findFirst({
        where: eq(elevenlabsCredentials.agentId, getAgentId()),
      });
      if (row?.valueEncrypted) {
        const apiKey = decryptStoredCredential(
          row.valueEncrypted,
          log,
          "tts: decrypt of stored ElevenLabs key failed — falling back to env",
        );
        if (apiKey !== null) {
          return { apiKey, voiceId: row.voiceId };
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "tts: ElevenLabs credential lookup failed (non-fatal) — falling back to env",
      );
    }
  }
  const envKey = process.env.ELEVENLABS_API_KEY;
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, voiceId: process.env.ELEVENLABS_VOICE_ID ?? null };
  }
  return null;
}

/**
 * Resolve the ElevenLabs voice id for a notification:
 *   1. per-project override row (project_voice_overrides) when project set
 *   2. `credentialVoiceId` — voice_id from the DB credential row / env
 *   3. ELEVENLABS_DEFAULT_VOICE_ID env var
 *   4. null → caller degrades to signal-only (Mac listener synthesizes
 *      locally); never a hard failure.
 *
 * Reuses the existing `projectVoiceOverrides` table — no new schema.
 */
async function resolveVoiceId(
  notification: NotificationRow,
  credentialVoiceId: string | null,
): Promise<string | null> {
  if (notification.project && ttsDbHandle) {
    try {
      const row = await ttsDbHandle
        .select({ voiceId: projectVoiceOverrides.voiceId })
        .from(projectVoiceOverrides)
        .where(eq(projectVoiceOverrides.project, notification.project))
        .limit(1);
      if (row[0]) return row[0].voiceId;
    } catch (err) {
      log.warn(
        {
          project: notification.project,
          err: err instanceof Error ? err.message : String(err),
        },
        "tts: project voice override lookup failed (non-fatal, falling back)",
      );
    }
  }
  return credentialVoiceId ?? defaultVoiceId();
}

/**
 * Send the notification body to ElevenLabs and return mp3 bytes.
 *
 * Structured errors (thrown — never returned):
 *   - HTTP 4xx/5xx → Error("elevenlabs http <status>")
 *   - Network/abort → underlying Error from fetchWithTimeout
 * The caller (`sendTtsNotification`) catches any throw and degrades to
 * signal-only `{ success: true }` so the notification still delivers and the
 * Mac listener synthesizes locally — synth is best-effort, never fatal.
 */
async function synthesizeViaElevenLabs(
  notification: NotificationRow,
  voiceId: string,
  apiKey: string,
): Promise<Uint8Array> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  // Sanitize bead-ID tokens out of the SPOKEN text only. The persisted row, the
  // desktop/banner body, and the Mac history all keep `notification.body`
  // untouched — this strip lives at the synthesis seam so IDs (e.g. `nx-2g2j4`)
  // are never read aloud as gibberish while remaining visible everywhere else.
  const spokenText = stripBeadIds(notification.body);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    timeout: 8_000,
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: spokenText,
      model_id: "eleven_turbo_v2",
    }),
  });
  if (!res.ok) {
    throw new Error(`elevenlabs http ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Real TTS channel handler — restored from the `signalOnlyChannel` stub by
 * `analytics-query-and-tts-synthesis`.
 *
 * TTS NEVER hard-fails. It always at least emits a signal-only
 * `NotificationFired` (success: true, no audio) so the Mac listener
 * (NexusShared.TTSObserver → ElevenLabsClient + Keychain) can synthesize
 * locally. Agent-side synthesis is a best-effort OPTIMIZATION: when it works
 * we pre-render the mp3 and ship it as `audioBase64` so the Mac can skip its
 * own synth round-trip; when it can't, we degrade to signal-only rather than
 * killing the whole notification (which would take down the banner too).
 *
 * Behavioural contract:
 *
 *   - `ELEVENLABS_API_KEY` unset → `{ success: true }` (signal-only; listener
 *     synthesizes via Keychain). Info-level log.
 *   - Voice id resolves to null (no project override + no env default) →
 *     `{ success: true }` (signal-only). Info-level log — this is an expected
 *     degradation, not an error; NO error-level log.
 *   - Voice resolution itself throws (e.g. DB hiccup in project-voice lookup)
 *     → `{ success: true }` (signal-only). Warn-level log — a transient DB
 *     error must never kill TTS.
 *   - HTTP 4xx/5xx / network timeout during synth → `{ success: true }`
 *     (signal-only). Warn-level log — a flaky ElevenLabs endpoint must not
 *     spam the error log on every notification; the Mac fallback handles it.
 *   - Synth success → persist mp3 to `~/.config/nexus/audio/<id>.mp3` via
 *     `writeAudio()`, base64-encode the bytes, return
 *     `{ success: true, audioBase64, voiceUsed }`.
 *
 * The ONLY path that returns `audioBase64` is the full happy path; every
 * other outcome degrades to signal-only `success: true`. This handler does
 * NOT return `success: false`.
 */
export async function sendTtsNotification(
  notification: NotificationRow,
): Promise<ChannelResult> {
  // Resolve the ElevenLabs key from the encrypted DB row first, then the env
  // var (add-elevenlabs-credential). Fresh read per dispatch → rotate without
  // restart. `null` means neither source has a key → signal-only.
  const credential = await resolveElevenLabsCredential();
  if (!credential) {
    log.info(
      { notificationId: notification.id },
      "tts: no ElevenLabs API key (DB row or env) — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }
  const apiKey = credential.apiKey;

  let voiceId: string | null;
  try {
    voiceId = await resolveVoiceId(notification, credential.voiceId);
  } catch (err) {
    // Voice resolution threw (e.g. DB hiccup in project-voice lookup).
    // Degrade to signal-only — a transient lookup error must never kill TTS.
    log.warn(
      {
        notificationId: notification.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "tts: voice id resolution threw — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }
  if (!voiceId) {
    // Expected degradation (no project override + ELEVENLABS_DEFAULT_VOICE_ID
    // unset), not an error. Emit signal-only so the Mac listener synthesizes
    // via Keychain. No error-level log — this is a normal fallback.
    log.info(
      { notificationId: notification.id, project: notification.project },
      "tts: no voice id available — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }

  // provider-qualified-project-voices: a resolved voice may be qualified
  // (`kokoro:af_heart`) or bare (implicitly `elevenlabs`, backward compat).
  // Only `elevenlabs` pre-renders here — any other provider is owned by the
  // Mac listener's provider chain, so the agent stays headless and degrades
  // to signal-only.
  const qualified = parseQualifiedVoice(voiceId);
  if (qualified.provider !== "elevenlabs") {
    log.debug(
      { notificationId: notification.id, provider: qualified.provider },
      "tts: voice provider is not elevenlabs — emitting signal-only NotificationFired (listener owns synthesis for this provider)",
    );
    return { success: true };
  }

  try {
    const mp3 = await synthesizeViaElevenLabs(
      notification,
      qualified.voice,
      apiKey,
    );
    await writeAudio(notification.id, mp3);
    // Base64-encode for SSE transport. Buffer is available in both Bun and
    // Node runtimes via the global.
    const audioBase64 = Buffer.from(mp3).toString("base64");
    return { success: true, audioBase64, voiceUsed: qualified.voice };
  } catch (err) {
    // Synth HTTP/network error. Degrade to signal-only so the notification
    // still delivers (banner + listener-side synth) — a flaky ElevenLabs
    // endpoint must not kill TTS. Warn-only, no error-level log (would spam
    // the error log on every notification during an outage; the Mac fallback
    // covers synthesis).
    log.warn(
      {
        notificationId: notification.id,
        voiceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "tts: ElevenLabs synthesis failed — emitting signal-only NotificationFired (listener falls back to local synth)",
    );
    return { success: true };
  }
}
