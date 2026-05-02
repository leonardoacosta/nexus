/**
 * Speakability predicate — decides whether a notification body should be
 * routed to TTS. Bodies that read like raw file paths, hashes, or other
 * unspeakable noise return `true` from `isUnspeakable()` and are stripped
 * from the TTS channel by the socket dispatcher.
 *
 * Why this lives here, not inside `channels/tts.ts`:
 *   The TTS channel's signal-only fallback (no API key / API failure) still
 *   surfaces a `NotificationFired` lifecycle event with no audio, which the
 *   Mac listener interprets as "speak with local say(1)". Filtering inside
 *   the channel cannot suppress the local fallback. The dispatcher must
 *   strip "tts" from the channel list before the lifecycle event fires.
 *
 * Policy (Option B — image-extension anywhere): silence any body that
 * either (a) is itself a single path token ending in a file extension, or
 * (b) mentions a binary/image asset extension anywhere. Catches both the
 * bare-path symptom (`/home/.../img-*.png`) and sentence-form leaks like
 * "saved screenshot to /tmp/foo.png".
 *
 * Tests: see `speakability.test.ts`.
 */

const FILE_PATH_ONLY = /^[~/]|^\.{1,2}\//;
const HAS_EXTENSION = /\.[a-z0-9]{2,5}$/i;

/** Asset extensions that should never be read aloud, anywhere in the body. */
const UNSPEAKABLE_EXT = /\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff|heic|mp4|mov|webm|pdf)\b/i;

/**
 * Returns true when `body` should NOT be sent to TTS. The dispatcher uses
 * this to strip the "tts" channel from a `notification` socket event.
 *
 * Pure function — no side effects, no DB, no network.
 */
export function isUnspeakable(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;

  // (a) Bare single-token path (e.g. "/home/.../foo.png").
  if (!/\s/.test(trimmed) && FILE_PATH_ONLY.test(trimmed) && HAS_EXTENSION.test(trimmed)) {
    return true;
  }

  // (b) Mentions an image/binary asset extension anywhere.
  if (UNSPEAKABLE_EXT.test(trimmed)) return true;

  return false;
}
