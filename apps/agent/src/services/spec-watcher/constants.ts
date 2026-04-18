/**
 * Timing constants for the spec-watcher service.
 * These are intentionally kept local to this package — they are not shared
 * with other services and do not belong in @nexus/core.
 */

/** How often to run a full poll cycle (ms). */
export const POLL_INTERVAL_MS = 60_000;

/** Max projects to poll in one batch before sleeping. */
export const BATCH_SIZE = 4;

/** Delay between batches (ms). */
export const BATCH_DELAY_MS = 200;

/** Subprocess timeout for `openspec list --json` (ms). */
export const SUBPROCESS_TIMEOUT_MS = 5_000;

/** Delay after collecting all events before sending a batched TTS notification (ms). */
export const COALESCE_DELAY_MS = 1_000;

/**
 * Debounce applied to per-spec file-watch events. Burst writes (e.g. editor
 * saves, `bd sync`) can fire the watcher many times in rapid succession;
 * we coalesce them into a single targeted refresh.
 */
export const WATCH_DEBOUNCE_MS = 300;
