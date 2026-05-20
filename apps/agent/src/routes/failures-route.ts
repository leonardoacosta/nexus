/**
 * GET /failures — aggregated tool failure data.
 *
 * Split from operational.ts.
 *
 * Per-row shape (`top_errors[]`):
 *   {
 *     // ... existing aggregate fields (count, tool, project, message, stack)
 *     trace_id: string | null,        // OTel trace id; null on legacy rows
 *     stack_truncated: boolean,       // true when stack hit STACK_TRUNCATE_BYTES
 *   }
 *
 * Extended by `agent-payload-completeness` — the Swift `ScriptError` decoder
 * requires `stack_truncated` non-optional and `trace_id` optional. The
 * underlying buffer wiring is still a stub (the live Rust-agent → SQLite
 * path is being decommissioned for the Bun spine), but the response SHAPE
 * is pinned here so the gate catches future regressions when a real
 * implementation lands.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Default stack truncation threshold. Stacks longer than this should be
 * truncated at ingest, and `stack_truncated` set to true. Mirrored by the
 * Swift `ScriptError.stackTruncated` decoder.
 */
export const STACK_TRUNCATE_BYTES = 4 * 1024;

// ---------------------------------------------------------------------------
// Wire-row builder — exported for tests
// ---------------------------------------------------------------------------

interface ScriptErrorRow {
  trace_id?: string | null;
  stack?: string | null;
  stack_truncated?: boolean;
}

interface TopErrorRow {
  trace_id: string | null;
  stack_truncated: boolean;
  // (other aggregate fields layered in by the buffer when wired up)
}

/**
 * Build the wire-shape `top_errors[]` row from a raw script_errors row.
 *
 * Exported so the per-endpoint contract test (`failures-route.test.ts`) can
 * exercise the field projection without standing up the full aggregate
 * pipeline. Real callers will fold per-aggregate fields (count, tool,
 * project, message) on top of the values produced here.
 */
export function buildTopErrorRow(row: ScriptErrorRow): TopErrorRow {
  const traceId = typeof row.trace_id === "string" ? row.trace_id : null;
  // Prefer the persisted flag; fall back to a size check so legacy ingest
  // paths that never set the column still report a sane value.
  const stackTruncated =
    typeof row.stack_truncated === "boolean"
      ? row.stack_truncated
      : typeof row.stack === "string" && row.stack.length >= STACK_TRUNCATE_BYTES;
  return {
    trace_id: traceId,
    stack_truncated: stackTruncated,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleFailures(url: URL): Promise<Response> {
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? parseInt(daysParam, 10) : 7;

  // The failure buffer is backed by the Rust agent's SQLite. The live
  // aggregate isn't wired into the Bun spine yet — return a stub matching
  // the FULL expected shape (including the new `trace_id` and
  // `stack_truncated` fields on `top_errors[]`) so PayloadDecodeTests v2
  // can decode against this endpoint.
  return new Response(
    JSON.stringify({
      period_days: days,
      total: 0,
      by_tool: {},
      by_project: {},
      top_errors: [] as TopErrorRow[],
      trend: {
        current: 0,
        previous: 0,
        direction: "flat",
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
