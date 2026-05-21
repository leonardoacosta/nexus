/**
 * Contract + behavior tests for GET /failures.
 *
 * Original purpose: pin the `trace_id` (nullable) and `stack_truncated`
 * (non-optional) fields on each `top_errors[]` row so the Swift
 * `ScriptError` decoder's required-field contract has a matching
 * agent-side guarantee (agent-payload-completeness task 1.9).
 *
 * Extended by failures-investigation-and-surface (task 1.7) to cover the
 * full aggregate pipeline: empty, populated, malformed-tolerated, cap,
 * fingerprint dedup, count-sort, 20-cap, trend up/down/flat/zero-to-nonzero.
 *
 * Test isolation: each test points the ingester at a fresh tmpdir so the
 * user's real `~/.claude/scripts/state/failures` is never read.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTopErrorRow,
  handleFailures,
  aggregate,
  trendDirection,
  STACK_TRUNCATE_BYTES,
  MAX_WINDOW_DAYS,
  TOP_ERRORS_CAP,
} from "./failures-route";
import {
  setFailuresDir,
  resetFailuresDir,
  clearFailuresCache,
  type FailureEntry,
} from "../services/cc-failures-ingester";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;

function isoDay(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function tsDaysAgo(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 60 * 60 * 1000;
}

function writeJsonl(name: string, lines: string[]): void {
  writeFileSync(join(dir, name), lines.join("\n") + "\n");
}

function entry(
  overrides: Partial<FailureEntry> & { toolName: string; project: string },
): FailureEntry {
  return {
    timestamp: overrides.timestamp ?? Date.now(),
    toolName: overrides.toolName,
    errorSnippet: overrides.errorSnippet ?? "boom",
    commandSnippet: overrides.commandSnippet ?? "cmd",
    project: overrides.project,
    sessionId: overrides.sessionId ?? null,
  };
}

interface FailuresEnvelope {
  period_days: number;
  total: number;
  by_tool: Record<string, number>;
  by_project: Record<string, number>;
  top_errors: Array<{
    count: number;
    occurrences: number;
    tool: string;
    project: string;
    message: string;
    command: string;
    trace_id: string | null;
    stack_truncated: boolean;
  }>;
  trend: { current: number; previous: number; direction: string };
  source: string;
  parse_errors: number;
  error?: string;
}

async function readBody(res: Response): Promise<FailuresEnvelope> {
  return (await res.json()) as FailuresEnvelope;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-failures-route-"));
  setFailuresDir(dir);
  clearFailuresCache();
});

afterEach(() => {
  resetFailuresDir();
  clearFailuresCache();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Wire-row builder (preserved from agent-payload-completeness)
// ---------------------------------------------------------------------------

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
    const row = buildTopErrorRow({ stack: "tiny", stack_truncated: true });
    expect(row.stack_truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Aggregate — direct unit tests (no I/O)
// ---------------------------------------------------------------------------

describe("aggregate — fingerprint dedup", () => {
  it("dedupes identical (tool, error_snippet) into one row with count=N", () => {
    const now = Date.now();
    const entries: FailureEntry[] = [
      entry({ toolName: "Read", project: "nx", errorSnippet: "ENOENT", timestamp: now - 1000 }),
      entry({ toolName: "Read", project: "nx", errorSnippet: "ENOENT", timestamp: now - 2000 }),
      entry({ toolName: "Read", project: "nx", errorSnippet: "ENOENT", timestamp: now - 3000 }),
    ];
    const result = aggregate(entries, 1, now);
    expect(result.topErrors.length).toBe(1);
    expect(result.topErrors[0]!.count).toBe(3);
    expect(result.topErrors[0]!.occurrences).toBe(3);
  });

  it("first-occurrence wins for the command field", () => {
    const now = Date.now();
    const entries: FailureEntry[] = [
      entry({ toolName: "Bash", project: "nx", errorSnippet: "x", commandSnippet: "FIRST", timestamp: now - 5000 }),
      entry({ toolName: "Bash", project: "nx", errorSnippet: "x", commandSnippet: "SECOND", timestamp: now - 1000 }),
    ];
    const result = aggregate(entries, 1, now);
    expect(result.topErrors[0]!.command).toBe("FIRST");
  });

  it("sorts by count DESC, ties broken by tool ASC", () => {
    const now = Date.now();
    const mk = (tool: string, snippet: string, times: number): FailureEntry[] =>
      Array.from({ length: times }, () =>
        entry({ toolName: tool, project: "nx", errorSnippet: snippet, timestamp: now - 1000 }),
      );
    const result = aggregate(
      [
        ...mk("Read", "a", 4),
        ...mk("Bash", "b", 7),
        ...mk("Write", "c", 12),
      ],
      1,
      now,
    );
    expect(result.topErrors.map((r) => r.count)).toEqual([12, 7, 4]);
    expect(result.topErrors.map((r) => r.tool)).toEqual(["Write", "Bash", "Read"]);
  });

  it("caps at TOP_ERRORS_CAP=20 rows, preserving the total", () => {
    const now = Date.now();
    const entries: FailureEntry[] = [];
    // 30 distinct fingerprints, count=1 each.
    for (let i = 0; i < 30; i++) {
      entries.push(
        entry({
          toolName: `Tool${String(i).padStart(2, "0")}`,
          project: "nx",
          errorSnippet: `err-${i}`,
          timestamp: now - 1000,
        }),
      );
    }
    const result = aggregate(entries, 1, now);
    expect(result.topErrors.length).toBe(TOP_ERRORS_CAP);
    expect(result.total).toBe(30);
  });

  it("populates by_tool and by_project maps", () => {
    const now = Date.now();
    const entries: FailureEntry[] = [
      entry({ toolName: "Read", project: "nx", timestamp: now - 100 }),
      entry({ toolName: "Read", project: "oo", timestamp: now - 200 }),
      entry({ toolName: "Read", project: "oo", timestamp: now - 300, errorSnippet: "other" }),
      entry({ toolName: "Bash", project: "nx", timestamp: now - 400 }),
    ];
    const result = aggregate(entries, 1, now);
    expect(result.byTool).toEqual({ Read: 3, Bash: 1 });
    expect(result.byProject).toEqual({ nx: 2, oo: 2 });
  });

  it("each top_errors row preserves trace_id=null + stack_truncated=false", () => {
    const now = Date.now();
    const result = aggregate(
      [entry({ toolName: "Read", project: "nx", timestamp: now - 100 })],
      1,
      now,
    );
    expect(result.topErrors[0]!.trace_id).toBeNull();
    expect(result.topErrors[0]!.stack_truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trend direction — direct unit tests
// ---------------------------------------------------------------------------

describe("trendDirection", () => {
  it("returns 'up' when current > previous * 1.1", () => {
    expect(trendDirection(50, 10)).toBe("up");
  });

  it("returns 'down' when current < previous * 0.9", () => {
    expect(trendDirection(5, 20)).toBe("down");
  });

  it("returns 'flat' inside the 10% band", () => {
    // 22 == 20 * 1.1 — must NOT be 'up' per spec scenario.
    expect(trendDirection(22, 20)).toBe("flat");
    expect(trendDirection(18, 20)).toBe("flat");
  });

  it("zero-to-nonzero is 'up'", () => {
    expect(trendDirection(3, 0)).toBe("up");
  });

  it("both zero is 'flat'", () => {
    expect(trendDirection(0, 0)).toBe("flat");
  });
});

// ---------------------------------------------------------------------------
// handleFailures — endpoint behavior
// ---------------------------------------------------------------------------

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
      source: string;
      parse_errors: number;
    };

    expect(body.period_days).toBe(7);
    expect(Array.isArray(body.top_errors)).toBe(true);
    expect(body.source).toBe("jsonl");
    expect(body.parse_errors).toBe(0);
  });
});

describe("handleFailures — aggregate end-to-end (failures-investigation-and-surface)", () => {
  it("empty filesystem returns total:0 with full envelope", async () => {
    const res = await handleFailures(
      new URL("http://localhost/failures?days=7"),
    );
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.total).toBe(0);
    expect(body.by_tool).toEqual({});
    expect(body.by_project).toEqual({});
    expect(body.top_errors).toEqual([]);
    expect(body.trend).toEqual({ current: 0, previous: 0, direction: "flat" });
    expect(body.source).toBe("jsonl");
    expect(body.parse_errors).toBe(0);
  });

  it("populated single day returns total + by_tool + by_project", async () => {
    const day = isoDay(0);
    const t = tsDaysAgo(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({ time: t, tool: "Read", error: "e1", command: "c", project: "nx" }),
      JSON.stringify({ time: t, tool: "Read", error: "e1", command: "c", project: "nx" }),
      JSON.stringify({ time: t, tool: "Read", error: "e1", command: "c", project: "nx" }),
      JSON.stringify({ time: t, tool: "Bash", error: "e2", command: "c", project: "nx" }),
      JSON.stringify({ time: t, tool: "Bash", error: "e2", command: "c", project: "nx" }),
    ]);
    const res = await handleFailures(
      new URL("http://localhost/failures?days=1"),
    );
    const body = await readBody(res);
    expect(body.total).toBe(5);
    expect(body.by_tool).toEqual({ Read: 3, Bash: 2 });
    expect(body.by_project).toEqual({ nx: 5 });
    // Two fingerprints, count-sorted DESC.
    expect(body.top_errors.length).toBe(2);
    expect(body.top_errors[0].count).toBe(3);
    expect(body.top_errors[1].count).toBe(2);
  });

  it("tolerates malformed lines and surfaces parse_errors", async () => {
    const day = isoDay(0);
    const t = tsDaysAgo(0);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        JSON.stringify({
          time: t,
          tool: "Read",
          error: `err${i}`,
          command: "c",
          project: "nx",
        }),
      );
    }
    lines.push("{not valid json");
    lines.push("also broken");
    writeJsonl(`${day}.jsonl`, lines);

    const res = await handleFailures(
      new URL("http://localhost/failures?days=1"),
    );
    const body = await readBody(res);
    expect(body.total).toBe(10);
    expect(body.parse_errors).toBe(2);
  });

  it("rejects days > 90 with 400", async () => {
    const res = await handleFailures(
      new URL("http://localhost/failures?days=91"),
    );
    expect(res.status).toBe(400);
    const body = await readBody(res);
    expect(body.error).toMatch(/max window/);
  });

  it("accepts days == MAX_WINDOW_DAYS (90)", async () => {
    const res = await handleFailures(
      new URL(`http://localhost/failures?days=${MAX_WINDOW_DAYS}`),
    );
    expect(res.status).toBe(200);
  });

  it("cache hit within 60s returns identical result", async () => {
    const day = isoDay(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(0),
        tool: "Read",
        error: "ok",
        command: "c",
        project: "nx",
      }),
    ]);
    const url = new URL("http://localhost/failures?days=1");
    const res1 = await handleFailures(url);
    const b1 = await readBody(res1);
    expect(b1.total).toBe(1);

    // Mutate the file. Cache hit must hide the change.
    writeFileSync(join(dir, `${day}.jsonl`), "");
    const res2 = await handleFailures(url);
    const b2 = await readBody(res2);
    expect(b2.total).toBe(1);
  });

  it("trend direction 'up' for significant increase", async () => {
    // Nudge timestamps a few seconds INSIDE each window so handler-time
    // `Date.now()` (slightly later than test setup) still classifies them
    // correctly. Without the nudge, an entry written at exactly `now-2d`
    // would fall just outside the previous window by the time the handler
    // runs.
    const dayMs = 24 * 60 * 60 * 1000;
    const inCurrent = Date.now() - 60_000; // 1 min ago: current window
    const inPrevious = Date.now() - dayMs - 60_000; // 1d1m ago: previous (days=1)
    const dayCurrent = new Date(inCurrent).toISOString().slice(0, 10);
    const dayPrev = new Date(inPrevious).toISOString().slice(0, 10);
    const mkLine = (t: number, i: number): string =>
      JSON.stringify({
        time: t,
        tool: "Read",
        error: `e${i}`,
        command: "c",
        project: "nx",
      });
    const currentLines = Array.from({ length: 50 }, (_, i) =>
      mkLine(inCurrent, i),
    );
    const prevLines = Array.from({ length: 10 }, (_, i) =>
      mkLine(inPrevious, i),
    );
    writeJsonl(`${dayCurrent}.jsonl`, currentLines);
    if (dayPrev !== dayCurrent) {
      writeJsonl(`${dayPrev}.jsonl`, prevLines);
    } else {
      // If "1d1m ago" lands on the same UTC day (unlikely but possible),
      // append to the same file.
      writeFileSync(
        join(dir, `${dayCurrent}.jsonl`),
        [...currentLines, ...prevLines].join("\n") + "\n",
      );
    }

    const res = await handleFailures(
      new URL("http://localhost/failures?days=1"),
    );
    const body = await readBody(res);
    expect(body.trend.current).toBe(50);
    expect(body.trend.previous).toBe(10);
    expect(body.trend.direction).toBe("up");
  });

  it("trend direction 'down' when previous dominates", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const inCurrent = Date.now() - 60_000;
    const inPrevious = Date.now() - dayMs - 60_000;
    const dayCurrent = new Date(inCurrent).toISOString().slice(0, 10);
    const dayPrev = new Date(inPrevious).toISOString().slice(0, 10);
    const mk = (t: number, i: number): string =>
      JSON.stringify({
        time: t,
        tool: "Bash",
        error: `e${i}`,
        command: "c",
        project: "nx",
      });
    const currentLines = [mk(inCurrent, 0), mk(inCurrent, 1)];
    const prevLines = Array.from({ length: 30 }, (_, i) => mk(inPrevious, i));
    if (dayPrev !== dayCurrent) {
      writeJsonl(`${dayCurrent}.jsonl`, currentLines);
      writeJsonl(`${dayPrev}.jsonl`, prevLines);
    } else {
      writeFileSync(
        join(dir, `${dayCurrent}.jsonl`),
        [...currentLines, ...prevLines].join("\n") + "\n",
      );
    }

    const res = await handleFailures(
      new URL("http://localhost/failures?days=1"),
    );
    const body = await readBody(res);
    expect(body.trend.previous).toBe(30);
    expect(body.trend.current).toBe(2);
    expect(body.trend.direction).toBe("down");
  });

  it("trend direction 'flat' when both windows are empty", async () => {
    const res = await handleFailures(
      new URL("http://localhost/failures?days=1"),
    );
    const body = await readBody(res);
    expect(body.trend.direction).toBe("flat");
  });

  it("trend zero-to-nonzero is 'up'", async () => {
    writeJsonl(`${isoDay(0)}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(0),
        tool: "Read",
        error: "e",
        command: "c",
        project: "nx",
      }),
    ]);
    const res = await handleFailures(
      new URL("http://localhost/failures?days=1"),
    );
    const body = await readBody(res);
    expect(body.trend.current).toBe(1);
    expect(body.trend.previous).toBe(0);
    expect(body.trend.direction).toBe("up");
  });
});
