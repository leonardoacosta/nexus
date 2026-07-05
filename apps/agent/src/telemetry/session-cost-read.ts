/**
 * Per-session cost + token read service.
 *
 * Spec: openspec/changes/read-cc-telemetry-from-influxdb (cc-telemetry-read)
 *
 * Sources per-session cost/token usage from the native Claude Code OpenTelemetry
 * series in VictoriaMetrics — replacing the retired transcript-tail
 * reconstruction (`credentials/token-stream/*` + `model-pricing.ts`):
 *
 *   - `claude_code_cost_usage_USD_total`  → cumulative USD cost
 *   - `claude_code_token_usage_total{type=…}` → per-type token counts
 *     (`type` ∈ input / output / cacheRead / cacheCreation)
 *
 * Every query pins `session_id="<id>"` AND `session_id=~".+"`. The regex matcher
 * is the mitigation cc's own Grafana dashboard applies: it excludes the
 * label-collision series (rows lacking a `session_id` label, produced by
 * concurrent sessions/subagents sharing a label set) that otherwise inflate the
 * per-session total. Pinning the exact id already requires the label; the `=~`
 * matcher documents and enforces that intent.
 */

import type { VmReadClient } from "./vm-read";

/** Per-session cost + token breakdown. Mirrors the `/sessions/{id}/tokens` aggregates shape. */
export interface SessionCostTokens {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  /** Cumulative USD cost, or null when no cost series exists for the session. */
  cost_usd: number | null;
}

const EMPTY: SessionCostTokens = {
  input: 0,
  output: 0,
  cache_creation: 0,
  cache_read: 0,
  cost_usd: null,
};

/** Escape a session id for safe interpolation into a PromQL double-quoted string. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Map cc's `type` label to the endpoint's aggregate keys. */
function tokenKey(type: string): keyof SessionCostTokens | null {
  switch (type) {
    case "input":
      return "input";
    case "output":
      return "output";
    case "cacheRead":
      return "cache_read";
    case "cacheCreation":
      return "cache_creation";
    default:
      return null;
  }
}

/**
 * Read a session's cost + token breakdown from VictoriaMetrics. Returns the
 * zero/empty breakdown (cost_usd null) when the client is disabled or no series
 * exist for the session — the caller maps that to HTTP 200, not an error.
 */
export async function readSessionCostTokens(
  client: VmReadClient,
  sessionId: string,
): Promise<SessionCostTokens> {
  if (!client.enabled) return { ...EMPTY };

  const sel = `session_id="${escapeLabel(sessionId)}",session_id=~".+"`;

  const [costSamples, tokenSamples] = await Promise.all([
    client.query(`claude_code_cost_usage_USD_total{${sel}}`),
    client.query(`claude_code_token_usage_total{${sel}}`),
  ]);

  const result: SessionCostTokens = { ...EMPTY };

  if (costSamples.length > 0) {
    result.cost_usd = costSamples.reduce((sum, s) => sum + s.value, 0);
  }

  for (const s of tokenSamples) {
    const key = tokenKey(s.metric.type ?? "");
    if (key && key !== "cost_usd") {
      result[key] += s.value;
    }
  }

  return result;
}
