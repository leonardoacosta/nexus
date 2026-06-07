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
 * Keywords that should never be read aloud, anywhere in the body.
 * Case-insensitive substring match. Add tokens here when a project or tool
 * name keeps leaking into TTS as noise.
 */
const UNSPEAKABLE_KEYWORDS = /\bghosty\b/i;

/**
 * Bead-ID token shape: a known project/tracker prefix + hyphen + 5–6
 * lowercase-alphanumeric chars (e.g. `nx-2g2j4`, `cc-lvyu9`). Anchored on the
 * known prefixes so we never strip real words that merely contain a hyphen.
 *
 * Prefixes are the two bead trackers whose IDs actually surface in Nexus
 * notifications: `nx` (this repo) and `cc` (the cc hook repo). The `i` flag is
 * intentionally omitted — bead IDs are always lowercase, and case-folding would
 * risk eating capitalised words.
 */
const BEAD_ID_TOKEN = /\b(?:nx|cc)-[a-z0-9]{4,6}\b/g;

/**
 * Strip bead-ID tokens (e.g. `nx-2g2j4`) from text destined for TTS so they are
 * not read aloud as gibberish, then clean up the punctuation/whitespace that the
 * removal leaves behind:
 *
 *   - `"fixed nx-2g2j4 and shipped"`        → `"fixed and shipped"`
 *   - `"[nx-2g2j4 nx-lvyu9]"`               → `""` (brackets collapse away)
 *   - `"close nx-abc12/nx-def34 done"`      → `"close done"`
 *
 * Cleanup steps after token removal:
 *   1. Collapse empty/near-empty bracket pairs left by a fully-stripped list,
 *      e.g. `[]`, `[ ]`, `( )`, `[ / ]`.
 *   2. Collapse leftover separators (`/`, `,`) flanked by spaces.
 *   3. Collapse runs of whitespace to a single space and trim.
 *
 * Pure function — applied ONLY at the TTS synthesis seam, never to the persisted
 * row, the desktop/banner body, or the Mac history (those keep the full ID).
 */
export function stripBeadIds(text: string): string {
  const stripped = text.replace(BEAD_ID_TOKEN, "");
  return stripped
    // A slash-separated ID list (`nx-a/nx-b/nx-c`) leaves a run of bare slashes
    // (`//`). Slashes are never normal prose between two spaces, so collapse any
    // run of `/` (with optional interior spaces) into a single space.
    .replace(/\/(?:\s*\/)*/g, " ")
    // Drop bracket pairs that now contain only separators/whitespace.
    .replace(/\[\s*[/,]?\s*\]/g, "")
    .replace(/\(\s*[/,]?\s*\)/g, "")
    // Tidy dangling separators (`,`/`/`) left orphaned between removed tokens —
    // i.e. flanked by whitespace on both sides. A real prose comma (`done, all`)
    // has no leading space and is left untouched.
    .replace(/\s+[/,]\s+/g, " ")
    .replace(/\s+[/,](?=\s|$)/g, "")
    // Collapse whitespace runs and trim.
    .replace(/\s{2,}/g, " ")
    .trim();
}

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

  // (c) Mentions an unspeakable keyword anywhere (e.g. "ghosty").
  if (UNSPEAKABLE_KEYWORDS.test(trimmed)) return true;

  return false;
}
