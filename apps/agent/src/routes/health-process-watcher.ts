/**
 * GET /health/process-watcher — observability probe for the process watcher.
 *
 * Spec: process-watcher-health-monitoring.
 *
 * Returns the watcher's heartbeat + tick state so operators can detect
 * stalls without scraping logs. Status 200 ALWAYS (probe, not an
 * enforcement gate) — the `healthy` boolean is the actionable signal:
 *
 *   { healthy: false, lastTickAgoSeconds: 142, ... }
 *
 * means a stall; the dashboard renders red.
 */

import type { Db } from "@nexus/db";
import {
  lastWatcherTickMs,
  lastWatcherReconcileError,
  lastWatcherLivePidCount,
  watcherResolverCacheHitRatio,
  staleRowCount,
} from "../services/process-watcher";
import { setStaleRowsGauge } from "../services/process-watcher-metrics";

/** Stalled threshold — `healthy: false` when `lastTickAgoSeconds >= 90`. */
const STALLED_HEALTH_SECONDS = 90;

export interface HealthProcessWatcherResponse {
  lastTickMs: number | null;
  lastTickAgoSeconds: number | null;
  lastReconcileError: string | null;
  livePidCount: number;
  staleRowCount: number;
  resolverCacheHitRatio: number;
  healthy: boolean;
}

export async function handleHealthProcessWatcher(db: Db): Promise<Response> {
  const ageMs = lastWatcherTickMs(); // monotonic ms since last tick; -1 = never ticked

  const lastTickAgoSeconds = ageMs < 0 ? null : Math.round(ageMs / 1000);
  const lastTickMs = ageMs < 0 ? null : Math.round(Date.now() - ageMs);

  // Stale-row count is best-effort — fail-soft to 0 inside `staleRowCount`.
  // Also mirror into the gauge so the future /metrics endpoint sees the
  // same value on the next scrape.
  const stale = await staleRowCount(db);
  setStaleRowsGauge(stale);

  const body: HealthProcessWatcherResponse = {
    lastTickMs,
    lastTickAgoSeconds,
    lastReconcileError: lastWatcherReconcileError(),
    livePidCount: lastWatcherLivePidCount(),
    staleRowCount: stale,
    resolverCacheHitRatio: watcherResolverCacheHitRatio(),
    healthy:
      lastTickAgoSeconds !== null && lastTickAgoSeconds < STALLED_HEALTH_SECONDS,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
