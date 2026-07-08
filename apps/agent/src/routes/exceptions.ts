/**
 * GET /exceptions (add-fleet-exceptions-feed).
 *
 * Fleet-wide beads/backlog exceptions — the shape, never the item list.
 * Response body is a JSON ARRAY of {@link FleetExceptionEntry}; a clean fleet
 * returns `[]`. Silent-when-clean is the load-bearing feature.
 *
 * Stale-while-revalidate: an in-memory cache (TTL 5 min) is served
 * immediately; when stale, a DETACHED background recompute is kicked off and
 * the current (possibly empty / stale) value is returned without blocking —
 * mirroring the roadmap-pulse cache shape. First-ever call returns `[]` and
 * triggers the first refresh.
 *
 * Fail-soft: any internal error returns `[]` with HTTP 200, never a 500.
 */

import { createLogger } from "@nexus/core/node";
import {
  computeFleetExceptions,
  type FleetExceptionEntry,
  type FleetExceptionsResult,
} from "../lib/fleet-exceptions";

const log = createLogger("agent:routes:exceptions");

export const EXCEPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// SWR cache (generic over the exceptions payload)
// ---------------------------------------------------------------------------

export interface ExceptionsCache {
  /** Current cached value (may be stale/empty); triggers a bg refresh if stale. */
  read(): FleetExceptionEntry[];
  /** Current cached value with NO side effect. */
  peek(): FleetExceptionEntry[];
  /** Whether the cache is past its TTL (or never populated). */
  isStale(): boolean;
  /** Force a refresh now (awaitable); guarded against overlap. */
  refresh(): Promise<void>;
}

export interface CreateExceptionsCacheOptions {
  ttlMs?: number;
  now?: () => number;
  compute?: () => Promise<FleetExceptionsResult>;
}

export function createExceptionsCache(
  opts: CreateExceptionsCacheOptions = {},
): ExceptionsCache {
  const ttlMs = opts.ttlMs ?? EXCEPTIONS_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const compute = opts.compute ?? (() => computeFleetExceptions());

  let cached: FleetExceptionEntry[] = [];
  let computedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  function isStale(): boolean {
    return now() - computedAt > ttlMs;
  }

  function refresh(): Promise<void> {
    // Coalesce concurrent refreshes — one recompute in flight at a time.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await compute();
        cached = result.exceptions;
        computedAt = now();
      } catch (err) {
        // Leave the stale cache untouched so it is retried next read
        // (roadmap-pulse: a failing refresh never clobbers the cache).
        log.warn({ err }, "fleet exceptions refresh failed; keeping stale cache");
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function read(): FleetExceptionEntry[] {
    if (isStale()) void refresh(); // detached — do not await
    return cached;
  }

  return { read, peek: () => cached, isStale, refresh };
}

// ---------------------------------------------------------------------------
// Module singleton + handler
// ---------------------------------------------------------------------------

const defaultCache = createExceptionsCache();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `GET /exceptions` handler. Returns the cached exceptions array (SWR). Any
 * error is swallowed to a fail-soft empty-200 — the surfaces treat an empty
 * array as "clean" and render nothing.
 */
export async function handleGetExceptions(
  cache: ExceptionsCache = defaultCache,
): Promise<Response> {
  try {
    return json(cache.read());
  } catch (err) {
    log.error({ err }, "exceptions handler failed; empty-200");
    return json([]);
  }
}
