/**
 * Process watcher counters/histograms — spec: process-watcher-health-monitoring.
 *
 * All values are in-process atomics (monotonic counters) or fixed-bucket
 * histograms. No external Prometheus client — the agent's `/metrics`
 * endpoint (when wired) serializes these straight to the Prometheus text
 * format. Today the endpoint does not exist; these counters are still
 * updated so that `/health/process-watcher` and tests can read them, and
 * so wiring `/metrics` later is a single read pass.
 *
 * Counter semantics (Prometheus convention):
 *   - `_total` counters increase forever; rate() is computed by the
 *     scraper.
 *   - The histogram uses fixed buckets (no quantile estimation in-process).
 */

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const counters = {
  pidsOpenedTotal: 0,
  pidsClosedTotal: 0,
  resolverCacheHitsTotal: 0,
  resolverCacheMissesTotal: 0,
};

let staleRowsGauge = 0;

// ---------------------------------------------------------------------------
// Histogram — nexus_pw_tick_duration_ms
// ---------------------------------------------------------------------------
//
// Fixed buckets matching the spec's "<50, <100, <500, <1000, <5000, +Inf"
// shape. Bucket cumulative semantics (each bucket includes everything in
// the buckets below it) — Prometheus convention.

const TICK_BUCKETS_MS = [50, 100, 500, 1000, 5000];
const tickBucketCounts = new Array(TICK_BUCKETS_MS.length + 1).fill(0);
let tickSumMs = 0;
let tickCount = 0;

export function recordTickDurationMs(ms: number): void {
  let placed = false;
  for (let i = 0; i < TICK_BUCKETS_MS.length; i++) {
    if (ms < TICK_BUCKETS_MS[i]!) {
      tickBucketCounts[i] += 1;
      placed = true;
      break;
    }
  }
  if (!placed) tickBucketCounts[TICK_BUCKETS_MS.length] += 1;
  tickSumMs += ms;
  tickCount += 1;
}

export function incPidsOpened(n: number = 1): void {
  counters.pidsOpenedTotal += n;
}

export function incPidsClosed(n: number = 1): void {
  counters.pidsClosedTotal += n;
}

export function incResolverCacheHits(n: number = 1): void {
  counters.resolverCacheHitsTotal += n;
}

export function incResolverCacheMisses(n: number = 1): void {
  counters.resolverCacheMissesTotal += n;
}

export function setStaleRowsGauge(n: number): void {
  staleRowsGauge = n;
}

/**
 * Snapshot the current counter / histogram / gauge values. Pure read —
 * no side-effects. Shape mirrors a Prometheus textfile-collector dump so
 * a future `/metrics` handler can serialize it directly.
 */
export function snapshotMetrics(): {
  counters: typeof counters;
  staleRowsGauge: number;
  tickHistogram: {
    buckets: number[];
    counts: number[];
    sumMs: number;
    count: number;
  };
} {
  return {
    counters: { ...counters },
    staleRowsGauge,
    tickHistogram: {
      buckets: [...TICK_BUCKETS_MS],
      counts: [...tickBucketCounts],
      sumMs: tickSumMs,
      count: tickCount,
    },
  };
}

/**
 * Reset all counters + histograms + gauge. Test-only — production code
 * MUST NOT call this; counters are monotonic by Prometheus contract.
 */
export function __resetMetricsForTests(): void {
  counters.pidsOpenedTotal = 0;
  counters.pidsClosedTotal = 0;
  counters.resolverCacheHitsTotal = 0;
  counters.resolverCacheMissesTotal = 0;
  staleRowsGauge = 0;
  tickBucketCounts.fill(0);
  tickSumMs = 0;
  tickCount = 0;
}
