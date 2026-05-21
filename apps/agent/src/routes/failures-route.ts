/**
 * GET /failures — aggregated tool failure data.
 *
 * Source-of-truth: `~/.claude/scripts/state/failures/YYYY-MM-DD.jsonl`
 * — one file per day of CC tool-failure events.
 *
 * Aggregation contract (response body):
 *
 *   {
 *     period_days: number,
 *     total: number,                              // count over current window
 *     by_tool: Record<string, number>,            // tool name → count
 *     by_project: Record<string, number>,         // project slug → count
 *     top_errors: TopErrorRow[],                  // top 20, fingerprint-deduped
 *     trend: { current, previous, direction },    // current vs previous window
 *     source: "jsonl",                            // provenance
 *     parse_errors: number,                       // malformed-line count
 *   }
 *
 * Per-row shape (`top_errors[]`):
 *   {
 *     count, tool, project, message, command, captured_at,
 *     fingerprint: string,        // sha256(tool + error[:200])
 *     trace_id: null,             // JSONL schema doesn't carry one yet
 *     stack: null,
 *     stack_truncated: false,     // see STACK_TRUNCATE_BYTES note
 *     occurrences: number,        // mirror of `count` for FailureSummary decoder
 *     script: string,             // mirror of `tool` for FailureSummary decoder
 *     id: string,                 // = fingerprint
 *   }
 *
 * The `trace_id` and `stack_truncated` fields are preserved verbatim from
 * the agent-payload-completeness contract so the Swift `ScriptError`
 * decoder's required-field guarantees still hold.
 *
 * Max window: `days > 90` returns `400 { error: "max window is 90 days" }`.
 */

import { createHash } from "node:crypto";
import {
  ingestFailures,
  type FailureEntry,
} from "../services/cc-failures-ingester";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Default stack truncation threshold. Stacks longer than this should be
 * truncated at ingest, and `stack_truncated` set to true. Mirrored by the
 * Swift `ScriptError.stackTruncated` decoder.
 */
export const STACK_TRUNCATE_BYTES = 4 * 1024;

/** Maximum window size enforced by the endpoint. */
export const MAX_WINDOW_DAYS = 90;

/** Maximum number of `top_errors[]` rows returned. */
export const TOP_ERRORS_CAP = 20;

/** Number of characters of the error snippet folded into the fingerprint. */
export const FINGERPRINT_ERROR_PREFIX_LEN = 200;

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
  // (other aggregate fields layered in below)
}

/**
 * Build the wire-shape `top_errors[]` row tail from a raw script_errors
 * row. Preserved from the `agent-payload-completeness` contract so the
 * Swift `ScriptError` decoder's required-field guarantees still hold.
 *
 * Real callers fold per-aggregate fields (count, tool, project, message,
 * etc.) on top of the values produced here — see `buildAggregatedRow`.
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
// Aggregation
// ---------------------------------------------------------------------------

interface AggregatedRow {
  id: string;
  fingerprint: string;
  count: number;
  occurrences: number;
  tool: string;
  script: string;
  project: string;
  message: string;
  command: string;
  captured_at: string;
  stack: string | null;
  trace_id: string | null;
  stack_truncated: boolean;
}

interface AggregateResult {
  total: number;
  byTool: Record<string, number>;
  byProject: Record<string, number>;
  topErrors: AggregatedRow[];
  trend: {
    current: number;
    previous: number;
    direction: "up" | "down" | "flat";
  };
}

/**
 * Stable fingerprint for dedup. Per spec:
 *   sha256(tool_name + error_snippet[:200])
 */
function fingerprintFor(toolName: string, errorSnippet: string): string {
  const h = createHash("sha256");
  h.update(toolName);
  h.update(errorSnippet.slice(0, FINGERPRINT_ERROR_PREFIX_LEN));
  return h.digest("hex");
}

/**
 * Slice entries into current + previous windows and produce the full
 * aggregate. `nowMs` injected for deterministic tests.
 */
export function aggregate(
  entries: FailureEntry[],
  days: number,
  nowMs: number,
): AggregateResult {
  const dayMs = 24 * 60 * 60 * 1000;
  const currentStart = nowMs - days * dayMs;
  const previousStart = nowMs - 2 * days * dayMs;

  const current: FailureEntry[] = [];
  let previousCount = 0;
  for (const e of entries) {
    if (e.timestamp >= currentStart && e.timestamp <= nowMs) {
      current.push(e);
    } else if (
      e.timestamp >= previousStart &&
      e.timestamp < currentStart
    ) {
      previousCount += 1;
    }
  }

  const byTool: Record<string, number> = {};
  const byProject: Record<string, number> = {};

  // Fingerprint → accumulator. First-seen wins for `command` per spec.
  const buckets = new Map<string, AggregatedRow>();

  for (const e of current) {
    byTool[e.toolName] = (byTool[e.toolName] ?? 0) + 1;
    if (e.project) {
      byProject[e.project] = (byProject[e.project] ?? 0) + 1;
    }
    const fp = fingerprintFor(e.toolName, e.errorSnippet);
    const existing = buckets.get(fp);
    if (existing) {
      existing.count += 1;
      existing.occurrences = existing.count;
      // Track latest captured_at — gives the row a freshness signal.
      const candidate = new Date(e.timestamp).toISOString();
      if (candidate > existing.captured_at) {
        existing.captured_at = candidate;
      }
    } else {
      const tail = buildTopErrorRow({
        trace_id: null,
        stack: null,
        stack_truncated: false,
      });
      buckets.set(fp, {
        id: fp,
        fingerprint: fp,
        count: 1,
        occurrences: 1,
        tool: e.toolName,
        script: e.toolName,
        project: e.project,
        message: e.errorSnippet,
        command: e.commandSnippet,
        captured_at: new Date(e.timestamp).toISOString(),
        stack: null,
        trace_id: tail.trace_id,
        stack_truncated: tail.stack_truncated,
      });
    }
  }

  // Sort: count DESC, then tool ASC for stable tie-break. Cap at 20.
  const topErrors = Array.from(buckets.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tool.localeCompare(b.tool);
    })
    .slice(0, TOP_ERRORS_CAP);

  const total = current.length;
  const direction = trendDirection(total, previousCount);

  return {
    total,
    byTool,
    byProject,
    topErrors,
    trend: { current: total, previous: previousCount, direction },
  };
}

/**
 * Trend direction per spec:
 *   up    when current > previous * 1.1
 *   down  when current < previous * 0.9
 *   flat  otherwise
 *   Special: previous==0 AND current>0  => "up"
 *            both 0                     => "flat"
 */
export function trendDirection(
  current: number,
  previous: number,
): "up" | "down" | "flat" {
  if (previous === 0 && current === 0) return "flat";
  if (previous === 0 && current > 0) return "up";
  if (current > previous * 1.1) return "up";
  if (current < previous * 0.9) return "down";
  return "flat";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleFailures(url: URL): Promise<Response> {
  const daysParam = url.searchParams.get("days");
  const parsed = daysParam ? parseInt(daysParam, 10) : 7;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;

  if (days > MAX_WINDOW_DAYS) {
    return new Response(
      JSON.stringify({ error: "max window is 90 days" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { entries, parseErrors } = await ingestFailures(days);
  const agg = aggregate(entries, days, Date.now());

  return new Response(
    JSON.stringify({
      period_days: days,
      total: agg.total,
      by_tool: agg.byTool,
      by_project: agg.byProject,
      top_errors: agg.topErrors,
      trend: agg.trend,
      source: "jsonl",
      parse_errors: parseErrors,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
