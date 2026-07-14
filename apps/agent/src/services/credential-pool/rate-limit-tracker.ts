/**
 * In-memory rate-limit tracker for credential fingerprints.
 *
 * Spec: openspec/changes/credentials-rich-emission task 1.3
 *
 * Maintains a per-fingerprint ring buffer of 429-response timestamps with a
 * 24-hour TTL. Queried by the credential-pool reader to project
 * `rateLimit429Count` per row in the `/credentials` wire shape.
 *
 * Design notes
 * ────────────
 * - In-memory only (per agent process). Restarts zero the counter — the
 *   spec marks rate-limit state as "signal-only, not hard durable".
 *   Persistence can be added later by mirroring writes into `cc_profiles`
 *   or a sibling SQLite table without changing this surface.
 * - Pruning happens lazily on read (`count24h` calls `pruneStale()` for the
 *   queried fingerprint). A separate `pruneStale()` over all fingerprints is
 *   exported for callers that want to compact periodically.
 * - The "ring buffer" is just an array of timestamps. We don't cap it —
 *   24h of 429s on a single fingerprint is bounded by Anthropic's RL
 *   policy (rarely more than a few hundred). Memory is irrelevant at that
 *   scale.
 */

import { registerSnapshotSource } from "../state-snapshot";

/** TTL window in milliseconds (24h). */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Per-fingerprint failure timestamp arrays. Module-level singleton. */
const failuresByFingerprint = new Map<string, number[]>();

/**
 * Record an HTTP response status against a fingerprint. Only 429s are
 * stored; other statuses are silently ignored so callers can pipe every
 * response through unconditionally.
 */
export function recordFailure(fingerprint: string, status: number): void {
  if (status !== 429) return;
  if (!fingerprint) return;
  const bucket = failuresByFingerprint.get(fingerprint) ?? [];
  bucket.push(Date.now());
  failuresByFingerprint.set(fingerprint, bucket);
}

/**
 * Count 429s recorded for `fingerprint` within the trailing 24h window.
 * Prunes stale entries for that fingerprint as a side effect so the
 * in-memory store doesn't grow unboundedly under sustained traffic.
 */
export function count24h(fingerprint: string): number {
  if (!fingerprint) return 0;
  const bucket = failuresByFingerprint.get(fingerprint);
  if (!bucket || bucket.length === 0) return 0;

  const cutoff = Date.now() - TTL_MS;
  const fresh = bucket.filter((ts) => ts >= cutoff);
  if (fresh.length === 0) {
    failuresByFingerprint.delete(fingerprint);
    return 0;
  }
  if (fresh.length !== bucket.length) {
    failuresByFingerprint.set(fingerprint, fresh);
  }
  return fresh.length;
}

/**
 * Prune stale (>24h) entries across all fingerprints. Cheap — only
 * traverses fingerprints that actually have entries. Safe to call on a
 * timer or on idle.
 */
export function pruneStale(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [fp, bucket] of failuresByFingerprint) {
    const fresh = bucket.filter((ts) => ts >= cutoff);
    if (fresh.length === 0) {
      failuresByFingerprint.delete(fp);
    } else if (fresh.length !== bucket.length) {
      failuresByFingerprint.set(fp, fresh);
    }
  }
}

/**
 * Test-only: reset all tracked state. Exported so unit tests can isolate
 * cases without interference from other test files in the same process.
 */
export function __resetForTests(): void {
  failuresByFingerprint.clear();
}

// Persist the 24h 429 tracker across restarts (nx-veo5g.4, Layer D). The signal
// is "how rate-limited has this credential been lately"; a restart previously
// zeroed it, hiding recent 429 pressure from the dashboard. Stale (>24h)
// timestamps are dropped on serialize AND restore so the store never grows.
registerSnapshotSource("rate-limit-tracker", {
  serialize: () => {
    const cutoff = Date.now() - TTL_MS;
    const out: [string, number[]][] = [];
    for (const [fp, bucket] of failuresByFingerprint) {
      const fresh = bucket.filter((ts) => ts >= cutoff);
      if (fresh.length > 0) out.push([fp, fresh]);
    }
    return out;
  },
  deserialize: (data) => {
    const cutoff = Date.now() - TTL_MS;
    failuresByFingerprint.clear();
    for (const [fp, bucket] of data as [string, number[]][]) {
      if (typeof fp !== "string" || !Array.isArray(bucket)) continue;
      const fresh = bucket.filter((ts) => typeof ts === "number" && ts >= cutoff);
      if (fresh.length > 0) failuresByFingerprint.set(fp, fresh);
    }
  },
});
