/**
 * Failure wire types — what `GET /failures` returns.
 *
 * The runtime aggregator lives in `apps/agent/src/routes/failures-route.ts`;
 * this file pins the canonical wire shape so the Swift `ScriptError`
 * decoder (PayloadDecodeTests v2) has a stable contract on both sides
 * of the boundary.
 *
 * Added by `agent-payload-completeness` — closes the missing
 * `trace_id` + `stack_truncated` gap on `/failures.top_errors[]`.
 */

/** A single aggregated error row in `GET /failures.top_errors[]`. */
export interface FailureTopError {
  /** OTel trace id propagated from the originating span. Null on legacy rows. */
  trace_id: string | null;
  /**
   * True when the row's serialized stack was truncated at ingest because
   * it exceeded the agent's configured threshold (default 4KB).
   */
  stack_truncated: boolean;
  // Aggregate fields (count / tool / project / message / stack) layered
  // in by the buffer when the aggregator is wired up — pinned here as
  // forward-compatible spread rather than enumerated, since the Swift
  // decoder reads them via `decodeIfPresent`.
}

/** Trend direction for the failures rate over the configured window. */
export type FailureTrendDirection = "up" | "down" | "flat";

/** Trend summary embedded in `GET /failures`. */
export interface FailureTrend {
  current: number;
  previous: number;
  direction: FailureTrendDirection;
}

/** Full `GET /failures` response shape. */
export interface FailuresResponse {
  period_days: number;
  total: number;
  by_tool: Record<string, number>;
  by_project: Record<string, number>;
  top_errors: FailureTopError[];
  trend: FailureTrend;
}
