/**
 * Process-scoped TTL cache for agent reachability results.
 *
 * Shared by `agent-reachability.ts` (writes successful probes) and
 * `agent-failover.ts` (reads the active agent before issuing a fetch).
 * The cache is module-scoped — one instance per Node process — and uses
 * lazy expiry (no setTimeout, no background sweep): expired entries are
 * pruned on the next `get()` that touches them.
 *
 * Design constraints (see openspec/changes/dashboard-agent-failover):
 *   - Failure results MUST NOT be cached. Caching `ok: false` would pin the
 *     dashboard to a dead agent for the TTL window even after it recovers.
 *   - Keys are opaque strings — the canonical key callers use is "active",
 *     but the cache itself is generic so future per-tenant variants don't
 *     require a refactor.
 *   - Type-only import of `Reachability` — `agent-reachability.ts` imports
 *     this module at runtime, so we must avoid the reverse runtime edge.
 *
 * Spec: openspec/changes/dashboard-agent-failover/tasks.md [2.1]
 */

import type { Reachability } from "./agent-reachability";

const DEFAULT_TTL_MS = 60_000;

interface Entry {
  result: Reachability;
  expiresAt: number;
}

const store = new Map<string, Entry>();

/**
 * Test seam: tests can monkey-patch this to control the clock without
 * resorting to vi.useFakeTimers. Not part of the public API — internal use
 * only. Default is `Date.now`.
 */
let nowFn: () => number = () => Date.now();

/**
 * Returns the cached `Reachability` for `key` if present and unexpired.
 * Lazy-deletes the entry and returns `null` when expired.
 */
export function get(key: string): Reachability | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (nowFn() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.result;
}

/**
 * Stores a successful `Reachability` under `key` with the given TTL.
 * Failure results (`ok: false`) are silently ignored — see module header.
 */
export function set(
  key: string,
  result: Reachability,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  if (!result.ok) return;
  store.set(key, {
    result,
    expiresAt: nowFn() + ttlMs,
  });
}

/**
 * Removes the entry for `key` if present. No-op if missing.
 */
export function invalidate(key: string): void {
  store.delete(key);
}

/**
 * Drops every entry. Primarily used by tests; production callers prefer
 * `invalidate(key)` to avoid disturbing unrelated keys.
 */
export function clear(): void {
  store.clear();
}
