/**
 * Single-flight request coalescing (nx-veo5g.2 #2).
 *
 * A `project=all` aggregate fans a computation out across every fleet project;
 * one dashboard reload — or N dashboard clients polling at once — would each
 * kick off an independent full recompute today. `createSingleFlight` collapses
 * concurrent callers that share a key onto ONE in-flight promise: late arrivals
 * await the same computation instead of starting their own.
 *
 * This is coalescing, NOT caching — the map entry is cleared the moment the
 * computation settles, so a request that arrives after completion recomputes
 * fresh. There is no staleness window and no cache-invalidation contract.
 */

/**
 * Create a keyed single-flight function. Two calls with the same `key` that
 * overlap in time share the first call's promise; once it settles the key is
 * released so the next call recomputes.
 */
export function createSingleFlight<T>(): (
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();

  return function singleFlight(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;

    // The IIFE invokes `fn()` synchronously and clears the key on settle
    // (success OR failure) so a rejected computation never wedges the key.
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  };
}
