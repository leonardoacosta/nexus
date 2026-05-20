/**
 * In-memory swap tracker for credential fingerprints.
 *
 * Spec: openspec/changes/credentials-rich-emission task 1.4
 *
 * Records the last time the agent rotated the active credential. Both the
 * fingerprint being swapped OUT and the one being swapped IN receive the
 * same timestamp — the dashboard surfaces "last touched by rotation" rather
 * than two separate concepts.
 *
 * Design notes
 * ────────────
 * - In-memory only (per agent process). Restart-on-deploy zeroes the map.
 *   The signal is operational ("which credentials were swapped recently?")
 *   not historical accounting, so the lossy property is fine.
 * - `recordSwap(prevFp, newFp)` tolerates either side being null/empty so
 *   the cold-start case (no previous active credential) can call the hook
 *   without conditional branches at the call site.
 */

/** Per-fingerprint last-swap timestamps. Module-level singleton. */
const swapsByFingerprint = new Map<string, Date>();

/**
 * Record a swap event. Stamps `now` against both fingerprints (the one
 * leaving the active slot and the one entering). Null/empty fingerprints
 * are tolerated so cold-start callers don't need conditional branches.
 */
export function recordSwap(
  prevFp: string | null | undefined,
  newFp: string | null | undefined,
): void {
  const now = new Date();
  if (prevFp) swapsByFingerprint.set(prevFp, now);
  if (newFp) swapsByFingerprint.set(newFp, now);
}

/** Return the most recent swap timestamp for `fingerprint`, or null. */
export function lastSwapAt(fingerprint: string): Date | null {
  if (!fingerprint) return null;
  return swapsByFingerprint.get(fingerprint) ?? null;
}

/**
 * Test-only: reset all tracked state. Exported so unit tests can isolate
 * cases without interference from other test files in the same process.
 */
export function __resetForTests(): void {
  swapsByFingerprint.clear();
}
