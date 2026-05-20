/**
 * Contract test for GET /failures.top_errors[] row shape.
 *
 * Added by `agent-payload-completeness` (task 1.9). Pins the
 * `trace_id` (nullable) and `stack_truncated` (non-optional) fields on
 * each `top_errors[]` row so the Swift `ScriptError` decoder's
 * required-field contract has a matching agent-side guarantee.
 */

import { describe, it, expect } from "bun:test";
import {
  buildTopErrorRow,
  handleFailures,
  STACK_TRUNCATE_BYTES,
} from "./failures-route";

describe("buildTopErrorRow — wire shape (agent-payload-completeness)", () => {
  it("emits trace_id verbatim when the row carries one", () => {
    const row = buildTopErrorRow({
      trace_id: "0123456789abcdef0123456789abcdef",
      stack: "short stack",
      stack_truncated: false,
    });
    expect(row.trace_id).toBe("0123456789abcdef0123456789abcdef");
    expect(row.stack_truncated).toBe(false);
  });

  it("emits trace_id=null for legacy rows missing the column", () => {
    const row = buildTopErrorRow({ stack: "short stack" });
    expect(row.trace_id).toBeNull();
    expect(row.stack_truncated).toBe(false);
  });

  it("falls back to size check when stack_truncated is absent", () => {
    const longStack = "x".repeat(STACK_TRUNCATE_BYTES + 10);
    const row = buildTopErrorRow({ stack: longStack });
    expect(row.stack_truncated).toBe(true);
  });

  it("honours stack_truncated=true even when stack is short", () => {
    // The ingest layer may have truncated a stack to below the threshold
    // and still flagged it; the persisted flag wins.
    const row = buildTopErrorRow({ stack: "tiny", stack_truncated: true });
    expect(row.stack_truncated).toBe(true);
  });
});

describe("handleFailures — top_errors[] field contract", () => {
  it("returns 200 with the full envelope including top_errors as an array", async () => {
    const url = new URL("http://localhost/failures?days=7");
    const res = await handleFailures(url);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      period_days: number;
      total: number;
      by_tool: Record<string, number>;
      by_project: Record<string, number>;
      top_errors: unknown[];
      trend: { current: number; previous: number; direction: string };
    };

    expect(body.period_days).toBe(7);
    expect(Array.isArray(body.top_errors)).toBe(true);
    // Stub returns [] today — the contract is that every emitted row, when
    // the aggregator is wired, MUST have trace_id + stack_truncated. Pinned
    // by the buildTopErrorRow tests above.
  });
});
