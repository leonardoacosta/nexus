/**
 * GET /health/processes — dedicated endpoint for the top CPU / RAM process
 * lists collected by `HealthCollector`.
 *
 * Spec: openspec/changes/health-tab-process-view, requirement
 * `health-processes-endpoint`.
 *
 * Reads `state.healthCollector.getLatest()` and returns the cached snapshot's
 * `processes` block — NO recomputation per request. The collector ticks every
 * ~10s; this endpoint just exposes that cached payload to the Swift dashboard
 * so the process table can poll at its own cadence (5s) without paying for
 * a full /health round-trip.
 *
 * Contract:
 *   - `?limit=N` is optional, integer, 1..50. Default 10.
 *   - Invalid limit → 400 `{ error: "limit must be 1..50" }`.
 *   - Warming-up (collector hasn't ticked) → 200 with empty arrays and
 *     `collectedAt: null`. NEVER 500.
 */

import type { ServerState } from "../server-websocket";
import type { HealthProcessesResponse } from "@nexus/core";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

/**
 * Parse and validate the `?limit=` query param.
 * Returns `{ ok: true, limit }` or `{ ok: false, error }`.
 */
function parseLimit(raw: string | null): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, limit: DEFAULT_LIMIT };
  // Reject non-integer / floats / NaN / Infinity — only digit strings allowed.
  if (!/^-?\d+$/.test(raw)) return { ok: false, error: "limit must be 1..50" };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "limit must be 1..50" };
  }
  if (n < MIN_LIMIT || n > MAX_LIMIT) {
    return { ok: false, error: "limit must be 1..50" };
  }
  return { ok: true, limit: n };
}

/** Handle `GET /health/processes` against the collector singleton. */
export function handleHealthProcesses(url: URL, state: ServerState): Response {
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if (!limitResult.ok) {
    return new Response(JSON.stringify({ error: limitResult.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const latest = state.healthCollector.getLatest();

  // Warming-up case: the collector has not ticked yet (just-booted agent,
  // or watcher disabled). Surface an empty payload with `collectedAt: null`
  // so the Swift dashboard can distinguish "no data yet" from "error".
  if (!latest || !latest.processes) {
    const empty: HealthProcessesResponse = {
      top_cpu: [],
      top_ram: [],
      collectedAt: null,
    };
    return new Response(JSON.stringify(empty), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body: HealthProcessesResponse = {
    top_cpu: latest.processes.top_cpu.slice(0, limitResult.limit),
    top_ram: latest.processes.top_ram.slice(0, limitResult.limit),
    collectedAt: latest.collectedAt ?? null,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
