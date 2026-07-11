/**
 * Unit tests for nexus-statusline renderer.
 *
 * These exercise the pure renderStatusline() function with synthetic CC
 * payloads + dep stubs. The binary entry-point (main) is not exercised here;
 * it's covered by the section-3 smoke test (`echo '{}' | nexus-statusline`).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, spyOn, afterEach } from "bun:test";
import * as childProcess from "node:child_process";

import {
  renderStatusline,
  modelEffortToken,
  modelFamilyLetter,
  isBbProject,
  gatePulseLine,
  stripRadarStale,
  getRoadmapPulse,
  formatSpecsLine,
  formatRoadmapLine,
  getSpecsLine,
  getRoadmapLine,
  getDriftLine,
  formatDriftLine,
  formatSessionClock,
  getBarWidth,
  buildStdinUsage,
  resolveUsage,
  resolveContext,
  getSpeed,
  sessionContextPath,
  writeSessionContext,
  type CcInput,
  type UsageResponse,
} from "./index";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
  return s.replace(ANSI, "");
}

const baseDeps = {
  git: null,
  nexusData: null,
  usage: null,
  accountDomain: null,
  projectDir: "/home/nyaptor/dev/nx",
};

// ── 2.1 — canonical payload renders a context bar ────────────────────────────

describe("renderStatusline — CC canonical payload", () => {
  it("[2.1] renders context-bar + style segment for the 2026-07-05 canonical payload", () => {
    const ccInput: CcInput = {
      hook_event_name: "StatusLine",
      session_id: "abc",
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      workspace: { current_dir: "/home/x/dev/nx", project_dir: "/home/x/dev/nx" },
      output_style: { name: "tts-summary" },
      context_window: { used_percentage: 45, context_window_size: 1_000_000 },
    };
    const out = renderStatusline(ccInput, baseDeps);
    const stripped = strip(out);
    // Renders "CTX" gauge with 55% remaining
    expect(stripped).toContain("CTX");
    expect(stripped).toContain("55%");
    // output_style object form renders (truncated head before dash → "tts")
    expect(stripped).toContain("tts");
  });

  it("[2.1b] legacy bare-string output_style does not crash (degrades gracefully)", () => {
    // CC used to send a bare string; the type is now { name }, but an old payload
    // must not crash the renderer.
    const ccInput = { output_style: "tts-summary" } as unknown as CcInput;
    let out = "";
    expect(() => {
      out = renderStatusline(ccInput, baseDeps);
    }).not.toThrow();
    expect(typeof out).toBe("string");
  });

  // ── 2.2 — used_percentage:25 renders ~75% with CTX_HIGH ────────────────────

  it("[2.2] used_percentage:25 → 75% remaining, color CTX_HIGH (mint)", () => {
    const ccInput: CcInput = { context_window: { used_percentage: 25 } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).toContain("75%");
    // CTX_HIGH = \x1b[38;5;158m (mint)
    expect(out).toContain("\x1b[38;5;158m");
  });

  // ── 2.3 — used_percentage:85 renders ~15% with CTX_LOW ─────────────────────

  it("[2.3] used_percentage:85 → 15% remaining, color CTX_LOW (red)", () => {
    const ccInput: CcInput = { context_window: { used_percentage: 85 } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).toContain("15%");
    // CTX_LOW = \x1b[38;5;203m (red, applied when remaining <= 20%)
    expect(out).toContain("\x1b[38;5;203m");
  });

  // ── 2.4 — missing context_window renders no segment, never crashes ─────────

  it("[2.4] missing context_window — does not crash, omits context bar", () => {
    const ccInput: CcInput = {};
    let out: string;
    expect(() => {
      out = renderStatusline(ccInput, baseDeps);
    }).not.toThrow();
    // Should not contain the CTX label
    expect(strip(out!)).not.toContain("CTX ");
  });
});

// ── 2.5 / 2.6 — cost segment ────────────────────────────────────────────────

describe("renderStatusline — cost segment", () => {
  it("[2.5] total_cost_usd=0.12 renders $0.12 in DIM", () => {
    const ccInput: CcInput = { cost: { total_cost_usd: 0.12 } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).toContain("$0.12");
    // DIM = \x1b[38;5;240m
    expect(out).toContain("\x1b[38;5;240m$0.12");
  });

  it("[2.6] total_cost_usd=0.003 (below $0.01 threshold) renders no cost segment", () => {
    const ccInput: CcInput = { cost: { total_cost_usd: 0.003 } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).not.toContain("$0.00");
    expect(strip(out)).not.toContain("$0.01");
  });
});

// ── 2.7 — line-delta segment ────────────────────────────────────────────────

describe("renderStatusline — line-delta segment", () => {
  it("[2.7a] total_lines_added=10, removed=2 renders +10/-2", () => {
    const ccInput: CcInput = { cost: { total_lines_added: 10, total_lines_removed: 2 } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).toContain("+10/-2");
  });

  it("[2.7b] both zero renders no line-delta segment", () => {
    const ccInput: CcInput = { cost: { total_lines_added: 0, total_lines_removed: 0 } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).not.toContain("+0/-0");
  });
});

// ── 2.8 — output_style segment ──────────────────────────────────────────────

describe("renderStatusline — output_style segment", () => {
  it("[2.8a] output_style={name:'tts-summary'} renders an 8-char truncation", () => {
    const ccInput: CcInput = { output_style: { name: "tts-summary" } };
    const out = renderStatusline(ccInput, baseDeps);
    const stripped = strip(out);
    // Truncates to head before dash → "tts" (≤ 8 chars)
    expect(stripped).toContain("tts");
    // Must not contain full string (the truncation must actually fire)
    expect(stripped).not.toContain("tts-summary");
  });

  it("[2.8b] output_style={name:'default'} renders nothing (no segment)", () => {
    const ccInput: CcInput = { output_style: { name: "default" } };
    const out = renderStatusline(ccInput, baseDeps);
    expect(strip(out)).not.toContain("default");
  });
});

// ── 2.9 — rate-limit reset countdown ────────────────────────────────────────

describe("renderStatusline — rate-limit reset countdown", () => {
  it("[2.9] rate_limits.five_hour.resets_at = now+30m renders ↻30m", () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const in30Min = nowSecs + 30 * 60;
    const ccInput: CcInput = { rate_limits: { five_hour: { resets_at: in30Min } } };
    const deps = {
      ...baseDeps,
      // Provide a usage object so the 5H gauge actually renders
      usage: { five_hour: { utilization: 50 } },
    };
    const out = renderStatusline(ccInput, deps);
    const stripped = strip(out);
    // Countdown must use minutes format (< 1 hour)
    expect(stripped).toMatch(/↻(29|30)m/);
  });
});

// ── 2.10 — workspace.project_dir → basename, no git remote subprocess ───────

describe("renderStatusline — project resolution", () => {
  it("[2.10a] workspace.project_dir='/home/x/dev/oo' → 'oo' as project name", () => {
    const ccInput: CcInput = { workspace: { project_dir: "/home/x/dev/oo" } };
    // projectDir in baseDeps is /home/nyaptor/dev/nx; renderer must IGNORE it
    // when workspace.project_dir is supplied and use basename(project_dir).
    const out = renderStatusline(ccInput, baseDeps);
    const stripped = strip(out);
    expect(stripped).toContain("oo");
    // Must NOT have used the deps.projectDir-derived value
    expect(stripped).not.toContain("nx ");
  });

  it("[2.10b] renderer source contains no execSync / spawnSync / git remote get-url references", async () => {
    // Contract assertion: the renderer must not invoke any subprocess.
    // We assert this structurally by reading the module source and checking
    // that renderStatusline's body does not reference execSync. This is the
    // most reliable way to verify the contract "no git subprocess per render"
    // without runtime monkey-patching of read-only ESM exports.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
    // Locate the renderStatusline function body
    const startIdx = src.indexOf("export function renderStatusline");
    expect(startIdx).toBeGreaterThan(0);
    // Find the matching closing brace by tracking depth
    let depth = 0;
    const bodyStart = src.indexOf("{", startIdx);
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const body = src.slice(bodyStart, bodyEnd + 1);
    expect(body).not.toContain("execSync");
    expect(body).not.toContain("spawnSync");
    expect(body).not.toContain("remote get-url");
  });
});

// ── 4.1 — degraded-mode regression (covered here so it lives with related fixtures) ──

describe("renderStatusline — degraded mode", () => {
  it("[4.1] empty payload {} does not crash and renders without context segment", () => {
    const out = renderStatusline({}, baseDeps);
    // Must not throw, must produce a string (the session indicator + project code at minimum)
    expect(typeof out).toBe("string");
    expect(strip(out)).not.toContain("CTX ");
  });

  it("[4.1b] empty payload {} renders no 'undefined' or 'null' tokens", () => {
    // Regression guard: the degraded-mode path must never leak literal
    // "undefined" / "null" strings (template-string interpolation of a missing
    // optional field). This is the most common shape of a payload-handling
    // regression — covered here so the contract is asserted alongside the
    // other empty-payload behaviors.
    const out = renderStatusline({}, baseDeps);
    const stripped = strip(out);
    expect(stripped).not.toContain("undefined");
    expect(stripped).not.toContain("null");
  });
});

// ── 5.1 — roadmap-pulse segment (cc advisor-plans/026 / cc-0te2q) ─────────────

describe("renderStatusline — roadmap pulse segment", () => {
  it("[5.1] pulse string in deps renders at end of line", () => {
    const out = renderStatusline({}, { ...baseDeps, pulse: "next: ship the thing" });
    expect(strip(out)).toEndWith("\nnext: ship the thing");
  });

  it("[5.1b] null/absent pulse renders no segment", () => {
    const out = renderStatusline({}, { ...baseDeps, pulse: null });
    expect(strip(out)).not.toContain("next:");
  });

  it("[2.6] multi-line pulse (embedded \\n) renders as two separate rows", () => {
    const out = renderStatusline(
      {},
      { ...baseDeps, pulse: "next: Merge Slot\nradar:stale" },
    );
    const lines = strip(out).split("\n");
    // The parts row is lines[0]; the pulse contributes two distinct trailing rows,
    // NOT one squeezed line.
    expect(lines).toContain("next: Merge Slot");
    expect(lines).toContain("radar:stale");
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

// ── 2.6 — specs + roadmap lines (add-bead-proposal-roadmap-surface) ──────────

describe("formatSpecsLine", () => {
  const rollup = (
    closed: number,
    total: number,
    ready: number,
    blocked = 0,
  ) => ({ tasks: { total, closed, ready, blocked } });

  it("renders the top in-progress proposal as closed/total · N ready", () => {
    const projects = [
      {
        code: "nx",
        specs: [
          { name: "ios-session-nav", status: "active", beadRollup: rollup(14, 15, 1) },
        ],
      },
    ];
    expect(formatSpecsLine(projects, "nx")).toBe("ios-session-nav 14/15 · 1 ready");
  });

  it("picks the proposal with the most task activity (most closed)", () => {
    const projects = [
      {
        code: "nx",
        specs: [
          { name: "quiet", status: "active", beadRollup: rollup(2, 10, 3) },
          { name: "busy", status: "active", beadRollup: rollup(9, 12, 1) },
        ],
      },
    ];
    expect(formatSpecsLine(projects, "nx")).toBe("busy 9/12 · 1 ready");
  });

  it("omits proposals whose status is complete", () => {
    const projects = [
      {
        code: "nx",
        specs: [
          { name: "done", status: "complete", beadRollup: rollup(5, 5, 0) },
        ],
      },
    ];
    expect(formatSpecsLine(projects, "nx")).toBeNull();
  });

  it("omits proposals with no bead rollup or zero task total", () => {
    const projects = [
      {
        code: "nx",
        specs: [
          { name: "nobeads", status: "active", beadRollup: null },
          { name: "empty", status: "active", beadRollup: rollup(0, 0, 0) },
        ],
      },
    ];
    expect(formatSpecsLine(projects, "nx")).toBeNull();
  });

  it("returns null when the project code is not present / no projects", () => {
    expect(formatSpecsLine(undefined, "nx")).toBeNull();
    expect(formatSpecsLine([], "nx")).toBeNull();
    expect(
      formatSpecsLine(
        [{ code: "oo", specs: [{ name: "x", status: "active", beadRollup: rollup(1, 2, 1) }] }],
        "nx",
      ),
    ).toBeNull();
  });
});

describe("formatRoadmapLine", () => {
  const cap = (name: string, closed: number, total: number) => ({
    name,
    progress: { closedTasks: closed, totalTasks: total },
  });

  it("renders the least-complete capability as name + percent", () => {
    const caps = [cap("agent-lifecycle", 4, 10), cap("dashboard", 9, 10)];
    expect(formatRoadmapLine(caps)).toBe("agent-lifecycle 40%");
  });

  it("ignores capabilities with zero total tasks", () => {
    const caps = [cap("empty", 0, 0), cap("real", 3, 4)];
    expect(formatRoadmapLine(caps)).toBe("real 75%");
  });

  it("returns null on empty / undefined / all-zero-total", () => {
    expect(formatRoadmapLine(undefined)).toBeNull();
    expect(formatRoadmapLine([])).toBeNull();
    expect(formatRoadmapLine([cap("z", 0, 0)])).toBeNull();
  });
});

describe("renderStatusline — specs + roadmap trailing lines", () => {
  it("appends specs and roadmap lines each on their own row", () => {
    const out = renderStatusline(
      {},
      { ...baseDeps, specsLine: "ios-session-nav 14/15 · 1 ready", roadmapLine: "agent-lifecycle 40%" },
    );
    const lines = strip(out).split("\n");
    expect(lines).toContain("ios-session-nav 14/15 · 1 ready");
    expect(lines).toContain("agent-lifecycle 40%");
  });

  it("null specs/roadmap lines render no extra rows", () => {
    const out = renderStatusline({}, { ...baseDeps, specsLine: null, roadmapLine: null });
    expect(strip(out)).not.toContain("ready");
    expect(strip(out)).not.toContain("%");
  });

  it("coexists with the pulse line (pulse first, then specs, then roadmap)", () => {
    const out = renderStatusline(
      {},
      {
        ...baseDeps,
        pulse: "next: ship it",
        specsLine: "busy 9/12 · 1 ready",
        roadmapLine: "cap 40%",
      },
    );
    const s = strip(out);
    expect(s.indexOf("next: ship it")).toBeLessThan(s.indexOf("busy 9/12"));
    expect(s.indexOf("busy 9/12")).toBeLessThan(s.indexOf("cap 40%"));
  });
});

describe("getSpecsLine / getRoadmapLine — stale-while-revalidate cache", () => {
  it("first render (no cache) returns null and spawns a detached refresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-beadline-"));
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      // No cache file for this random dir → stale → null line + spawn fires.
      expect(getSpecsLine("/home/nyaptor/dev/zzznope", "http://localhost:7400")).toBeNull();
      expect(getRoadmapLine("/home/nyaptor/dev/zzznope", "http://localhost:7400")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      // Refresh command curls the agent endpoint into the cache file.
      const specArgs = spy.mock.calls[0]?.[1] as string[];
      expect(specArgs.join(" ")).toContain("/specs/all");
      const roadArgs = spy.mock.calls[1]?.[1] as string[];
      expect(roadArgs.join(" ")).toContain("/roadmap?project=zzznope");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// add-attention-guard — drift line + session clock
// ════════════════════════════════════════════════════════════════════════════

// ── 1.4 — drift matrix ───────────────────────────────────────────────────────

describe("formatDriftLine — foreign high-urgency queue head", () => {
  // Current session is "cc"; the head is a preempt on a "tl" request.
  const foreignPreempt = [
    {
      source: "tl",
      title: "P1 security fix",
      verdict: { action: "preempt", confidence: 0.9 },
    },
  ];

  it("foreign preempt head renders one drift line with action, title, source", () => {
    expect(formatDriftLine(foreignPreempt, "cc")).toBe(
      "head: preempt — P1 security fix (tl)",
    );
  });

  it("foreign HIGH-confidence (non-preempt) head still renders", () => {
    const items = [
      { source: "tl", title: "urgent review", verdict: { action: "delegate", confidence: 0.8 } },
    ];
    expect(formatDriftLine(items, "cc")).toBe("head: delegate — urgent review (tl)");
  });

  it("high-confidence via band STRING (no numeric score) renders", () => {
    const items = [
      { source: "tl", title: "review", verdict: { action: "group", confidenceBand: "high" } },
    ];
    expect(formatDriftLine(items, "cc")).toBe("head: group — review (tl)");
  });

  it("tolerates the nested protojson `core` spine shape", () => {
    const items = [
      { core: { source: "tl", title: "nested" }, verdict: { action: "preempt", confidence: 0.9 } },
    ];
    expect(formatDriftLine(items, "cc")).toBe("head: preempt — nested (tl)");
  });

  it("SILENT: same-project head (source === current project)", () => {
    const items = [
      { source: "cc", title: "own work", verdict: { action: "preempt", confidence: 0.9 } },
    ];
    expect(formatDriftLine(items, "cc")).toBeNull();
    // Case-insensitive
    expect(formatDriftLine([{ source: "CC", title: "x", verdict: { action: "preempt", confidence: 0.9 } }], "cc")).toBeNull();
  });

  it("SILENT: low-confidence, non-preempt head", () => {
    const items = [
      { source: "tl", title: "meh", verdict: { action: "defer", confidence: 0.3 } },
    ];
    expect(formatDriftLine(items, "cc")).toBeNull();
  });

  it("SILENT: medium-confidence, non-preempt head", () => {
    const items = [
      { source: "tl", title: "maybe", verdict: { action: "resolve", confidence: 0.5 } },
    ];
    expect(formatDriftLine(items, "cc")).toBeNull();
  });

  it("SILENT: verdict-less head (no verdict key)", () => {
    const items = [{ source: "tl", title: "no verdict" }];
    expect(formatDriftLine(items, "cc")).toBeNull();
  });

  it("SILENT: empty queue / undefined items", () => {
    expect(formatDriftLine([], "cc")).toBeNull();
    expect(formatDriftLine(undefined, "cc")).toBeNull();
  });

  it("SILENT: high-urgency but blank source (cannot establish foreignness)", () => {
    const items = [{ source: "", title: "x", verdict: { action: "preempt", confidence: 0.9 } }];
    expect(formatDriftLine(items, "cc")).toBeNull();
  });
});

describe("getDriftLine — stale-while-revalidate cache", () => {
  it("first render (no cache) returns null and spawns a detached /queue refresh", () => {
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      expect(getDriftLine("/home/nyaptor/dev/zzznope", "http://localhost:7400")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]?.[1] as string[];
      expect(args.join(" ")).toContain("/queue?limit=1");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("renderStatusline — drift line trailing row", () => {
  it("drift line renders as a trailing row (before the pulse line)", () => {
    const out = renderStatusline(
      {},
      { ...baseDeps, driftLine: "head: preempt — P1 fix (tl)", pulse: "next: ship it" },
    );
    const s = strip(out);
    const lines = s.split("\n");
    expect(lines).toContain("head: preempt — P1 fix (tl)");
    // Drift line sits above the pulse line
    expect(s.indexOf("head: preempt")).toBeLessThan(s.indexOf("next: ship it"));
  });

  it("null drift line renders no row", () => {
    const out = renderStatusline({}, { ...baseDeps, driftLine: null });
    expect(strip(out)).not.toContain("head:");
  });
});

// ── 1.4 — session clock formatting across boundaries ─────────────────────────

describe("formatSessionClock — passive elapsed time", () => {
  it("sub-hour renders <M>m", () => {
    expect(formatSessionClock(41 * 60_000)).toBe("41m");
    expect(formatSessionClock(0)).toBe("0m");
    expect(formatSessionClock(59 * 60_000)).toBe("59m");
  });

  it("at and past the hour boundary renders <H>h<MM>m (zero-padded minutes)", () => {
    expect(formatSessionClock(60 * 60_000)).toBe("1h00m");
    expect(formatSessionClock(61 * 60_000)).toBe("1h01m");
    // 2h41m — the spec's worked example
    expect(formatSessionClock(161 * 60_000)).toBe("2h41m");
  });

  it("truncates seconds (does not round up)", () => {
    // 41m59s → 41m
    expect(formatSessionClock(41 * 60_000 + 59_000)).toBe("41m");
  });

  it("returns null for missing / non-finite / negative durations (no segment)", () => {
    expect(formatSessionClock(undefined)).toBeNull();
    expect(formatSessionClock(NaN)).toBeNull();
    expect(formatSessionClock(-5)).toBeNull();
  });
});

describe("renderStatusline — session clock segment", () => {
  it("renders ⧗<clock> from cost.total_duration_ms", () => {
    const out = renderStatusline(
      { cost: { total_duration_ms: 161 * 60_000 } },
      baseDeps,
    );
    expect(strip(out)).toContain("⧗2h41m");
  });

  it("no duration renders no clock segment", () => {
    expect(strip(renderStatusline({}, baseDeps))).not.toContain("⧗");
  });
});

// ── 2.2 / 2.3 / 2.5 — new CC-metadata segments ───────────────────────────────

describe("renderStatusline — exceeds_200k marker", () => {
  it("[2.2] exceeds_200k_tokens:true renders the 200K+ marker", () => {
    const out = renderStatusline(
      { exceeds_200k_tokens: true, context_window: { used_percentage: 50 } },
      baseDeps,
    );
    expect(strip(out)).toContain("200K+");
  });

  it("[2.2b] exceeds_200k_tokens false/absent renders no marker", () => {
    expect(strip(renderStatusline({ exceeds_200k_tokens: false }, baseDeps))).not.toContain(
      "200K",
    );
    expect(strip(renderStatusline({}, baseDeps))).not.toContain("200K");
  });
});

describe("renderStatusline — model/effort token (supersedes standalone effort tag)", () => {
  it("combined token replaces the model version segment (Opus 4.8 + xhigh → Oxh, no '4.8', no 'xhigh')", () => {
    const out = renderStatusline(
      { model: { id: "claude-opus-4-8", display_name: "Opus 4.8" }, effort: { level: "xhigh" } },
      baseDeps,
    );
    const s = strip(out);
    expect(s).toContain("Oxh");
    // The old standalone effort tag and version-number segment are gone
    expect(s).not.toContain("xhigh");
    expect(s).not.toContain("4.8");
  });

  it("absent effort renders the letter alone (no suffix)", () => {
    const out = renderStatusline(
      { model: { id: "claude-opus-4-8", display_name: "Opus 4.8" } },
      baseDeps,
    );
    const s = strip(out);
    expect(s).toContain("O");
    expect(s).not.toContain("xhigh");
    expect(s).not.toContain("4.8");
  });
});

describe("renderStatusline — git_worktree badge", () => {
  it("[2.5] workspace.git_worktree renders a badge after the git segment", () => {
    const deps = { ...baseDeps, git: { branch: "main", dirty: false, ahead: 0 } };
    const out = renderStatusline(
      { workspace: { git_worktree: "my-feature" } },
      deps,
    );
    const s = strip(out);
    expect(s).toContain("my-feature");
    // Badge appears after the git branch segment ("main")
    expect(s.indexOf("my-feature")).toBeGreaterThan(s.indexOf("main"));
  });

  it("[2.5b] absent git_worktree renders no badge", () => {
    const deps = { ...baseDeps, git: { branch: "main", dirty: false, ahead: 0 } };
    const out = renderStatusline({}, deps);
    expect(strip(out)).not.toContain("my-feature");
  });
});

describe("renderStatusline — 7D rate-limit source precedence", () => {
  it("[2.4] rate_limits.seven_day.resets_at is preferred over agent-analytics 7D", () => {
    const now = Math.floor(Date.now() / 1000);
    const in30Min = now + 30 * 60;
    const analyticsResetIso = new Date((now + 3 * 86400) * 1000).toISOString();
    const usage = {
      seven_day: { utilization: 50, resets_at: analyticsResetIso },
    };

    // CC-supplied resets_at (30m) wins over the analytics-derived value (3d)
    const withCc = renderStatusline(
      { rate_limits: { seven_day: { resets_at: in30Min } } },
      { ...baseDeps, usage },
    );
    expect(strip(withCc)).toMatch(/7D.*↻(29|30)m/);

    // Absent CC value → falls back to the analytics-derived reset (3d)
    const without = renderStatusline({}, { ...baseDeps, usage });
    expect(strip(without)).toMatch(/7D.*↻3d/);
  });
});

// ── 2.7 — empty payload shows none of the new segments ───────────────────────

describe("renderStatusline — new-segment degraded parity", () => {
  it("[2.7] empty payload {} renders without any new segment appearing", () => {
    const out = renderStatusline({}, baseDeps);
    const s = strip(out);
    expect(typeof out).toBe("string");
    expect(s).not.toContain("200K");
    expect(s).not.toContain("xhigh");
    expect(s).not.toContain("my-feature");
    expect(s).not.toContain("⑂");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// add-statusline-radar-gate-and-effort-token
// ════════════════════════════════════════════════════════════════════════════

// ── 2.3 — model/effort token ─────────────────────────────────────────────────

describe("modelEffortToken", () => {
  it("[2.3] Fu — fable + max", () => {
    expect(
      modelEffortToken({ id: "claude-fable-5", display_name: "Fable 5" }, { level: "max" }),
    ).toBe("Fu");
  });

  it("[2.3] Sxh — sonnet + xhigh", () => {
    expect(
      modelEffortToken({ id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" }, { level: "xhigh" }),
    ).toBe("Sxh");
  });

  it("[2.3] O — opus, no effort → letter alone", () => {
    expect(modelEffortToken({ id: "claude-opus-4-8", display_name: "Opus 4.8" })).toBe("O");
  });

  it("[2.3] ultracode also maps to u", () => {
    expect(
      modelEffortToken({ id: "claude-fable-5" }, { level: "ultracode" }),
    ).toBe("Fu");
  });

  it("[2.3] no token when model absent (effort alone never renders)", () => {
    expect(modelEffortToken(undefined, { level: "max" })).toBeNull();
    expect(modelEffortToken({})).toBeNull();
  });

  it("[2.3] Nl — unknown family falls back to display_name initial", () => {
    expect(
      modelEffortToken({ id: "nova-x1", display_name: "Nova X1" }, { level: "low" }),
    ).toBe("Nl");
  });

  it("[2.3] unrecognized effort → letter alone", () => {
    expect(
      modelEffortToken({ id: "claude-opus-4-8" }, { level: "bogus" }),
    ).toBe("O");
  });

  it("[2.3] no standalone version-number segment remains in rendered output", () => {
    const out = renderStatusline(
      { model: { id: "claude-fable-5", display_name: "Fable 5" }, effort: { level: "max" } },
      baseDeps,
    );
    const s = strip(out);
    expect(s).toContain("Fu");
    expect(s).not.toContain("Fable");
    // The bare version number "5" must not appear as its own DIM segment
    expect(s).not.toMatch(/\s5\s/);
  });
});

describe("modelFamilyLetter — shared letter derivation", () => {
  it("derives the same letter modelEffortToken uses, without the effort suffix", () => {
    const model = { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" };
    expect(modelFamilyLetter(model)).toBe("S");
    expect(modelEffortToken(model, { level: "xhigh" })).toBe("Sxh");
  });

  it("unknown family falls back to display_name initial", () => {
    expect(modelFamilyLetter({ id: "nova-x1", display_name: "Nova X1" })).toBe("N");
  });

  it("no model → null", () => {
    expect(modelFamilyLetter(undefined)).toBeNull();
    expect(modelFamilyLetter({})).toBeNull();
  });
});

// ── cc-tmux-bar-cleanup 1.2 — session-context writer carries the model letter ─

describe("writeSessionContext — per-pane cache (cc-tmux-bar-cleanup)", () => {
  const pane = "%nx-test-model-letter";
  const path = sessionContextPath(pane);
  const origPane = process.env.TMUX_PANE;

  afterEach(() => {
    if (origPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = origPane;
    try {
      unlinkSync(path);
    } catch {
      // no file to clean up — fine
    }
  });

  it("writes both context_used_pct and the model letter in one JSON object", () => {
    process.env.TMUX_PANE = pane;
    writeSessionContext(62, "F");
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.context_used_pct).toBe(62);
    expect(written.model).toBe("F");
  });

  it("omits the model key (not null/empty) when no model letter is available", () => {
    process.env.TMUX_PANE = pane;
    writeSessionContext(62, null);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.context_used_pct).toBe(62);
    expect("model" in written).toBe(false);
  });

  it("no other per-render field (cost, lines, speed, style, worktree, spec) is written", () => {
    process.env.TMUX_PANE = pane;
    writeSessionContext(62, "O");
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(written).sort()).toEqual(["context_used_pct", "model", "ts"]);
  });

  it("outside tmux ($TMUX_PANE unset) is a no-op", () => {
    delete process.env.TMUX_PANE;
    writeSessionContext(62, "F");
    expect(() => readFileSync(path, "utf8")).toThrow();
  });
});

// ── 2.1 — B&B radar gate ─────────────────────────────────────────────────────

describe("isBbProject + radar gate", () => {
  it("[2.1] nx (non-B&B) strips radar:stale from the counts row, leaving 7o", () => {
    const isBb = isBbProject("/home/nyaptor/dev/nx");
    expect(isBb).toBe(false);
    expect(gatePulseLine("next: x\n7o,radar:stale", isBb)).toBe("next: x\n7o");
  });

  it("[2.1] ws (allowlist, no toml) keeps radar:stale", () => {
    const isBb = isBbProject("/home/nyaptor/dev/ws");
    expect(isBb).toBe(true);
    expect(gatePulseLine("next: x\n7o,radar:stale", isBb)).toBe("next: x\n7o,radar:stale");
  });

  it("[2.1] org = \"bb\" toml overrides a non-allowlisted code", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-bbgate-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude/project.toml"),
        '[project]\nname = "Personalish"\ncode = "zz"\norg = "bb"\n',
      );
      // basename(dir) is a random temp code, definitely not in the allowlist
      expect(isBbProject(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[2.1] org = \"personal\" toml overrides an allowlisted-style code to non-B&B", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-bbgate-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude/project.toml"),
        '[project]\norg = "personal"\n',
      );
      expect(isBbProject(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[2.1] unreadable/absent toml falls back to allowlist without throwing", () => {
    // Non-existent dir → readFileSync throws internally, caught, allowlist fallback
    expect(() => isBbProject("/nonexistent/path/xx")).not.toThrow();
    expect(isBbProject("/nonexistent/path/xx")).toBe(false);
  });

  it("[2.1] stripRadarStale drops a counts row that becomes empty", () => {
    expect(stripRadarStale("next: x\nradar:stale")).toBe("next: x");
    expect(stripRadarStale("radar:stale")).toBe("");
  });

  it("[2.1] gatePulseLine returns null when non-B&B strip empties the whole line", () => {
    expect(gatePulseLine("radar:stale", false)).toBeNull();
  });
});

// ── 2.2 — refresh spawn carries PULSE_RADAR ──────────────────────────────────

describe("getRoadmapPulse — PULSE_RADAR spawn env", () => {
  it("[2.2] non-B&B project spawns refresh with PULSE_RADAR=0", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-pulse-nonbb-"));
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      getRoadmapPulse(dir); // no cache → stale → spawn fires
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0]?.[2] as { env?: Record<string, string> };
      expect(opts?.env?.PULSE_RADAR).toBe("0");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[2.2] B&B project (org toml) spawns refresh with PULSE_RADAR=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-pulse-bb-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/project.toml"), '[project]\norg = "bb"\n');
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      getRoadmapPulse(dir);
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0]?.[2] as { env?: Record<string, string> };
      expect(opts?.env?.PULSE_RADAR).toBe("1");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 2.5 — CTX absolute usage (k/k) ───────────────────────────────────────────

describe("renderContext — absolute usage suffix", () => {
  it("[2.5] used_percentage:42 + context_window_size:200000 renders 84k/200k", () => {
    const out = renderStatusline(
      { context_window: { used_percentage: 42, context_window_size: 200000 } },
      baseDeps,
    );
    expect(strip(out)).toContain("84k/200k");
  });

  it("[2.5] missing context_window_size renders percentage-only (no k/k)", () => {
    const out = renderStatusline(
      { context_window: { used_percentage: 42 } },
      baseDeps,
    );
    const s = strip(out);
    expect(s).toContain("58%"); // 100 - 42 remaining
    expect(s).not.toContain("k/");
  });

  it("[2.5] context_window_size:0 (non-positive) renders percentage-only", () => {
    const out = renderStatusline(
      { context_window: { used_percentage: 42, context_window_size: 0 } },
      baseDeps,
    );
    expect(strip(out)).not.toContain("k/");
  });
});

// ── 2.6 — regression: empty payload crash-safe, no new behavior visible ──────

describe("add-statusline-radar-gate — empty payload regression", () => {
  it("[2.6] empty payload {} renders without throwing and shows no new behavior", () => {
    let out = "";
    expect(() => {
      out = renderStatusline({}, baseDeps);
    }).not.toThrow();
    const s = strip(out);
    // No model/effort token, no CTX k/k usage, no radar remnants
    expect(s).not.toContain("k/");
    expect(s).not.toContain("radar:stale");
    expect(s).not.toContain("undefined");
    expect(s).not.toContain("null");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// harden-statusline-context-usage-and-speed
// ════════════════════════════════════════════════════════════════════════════

// ── 1.6 — adaptive bar width ─────────────────────────────────────────────────

describe("getBarWidth — adaptive gauge width", () => {
  const origCols = process.env.COLUMNS;
  afterEach(() => {
    if (origCols === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = origCols;
  });

  it("COLUMNS=120 → 10 cells (wide)", () => {
    process.env.COLUMNS = "120";
    expect(getBarWidth()).toBe(10);
  });

  it("COLUMNS=50 → 4 cells (narrow)", () => {
    process.env.COLUMNS = "50";
    expect(getBarWidth()).toBe(4);
  });

  it("COLUMNS=60 / 99 → 6 cells (mid bucket boundaries)", () => {
    process.env.COLUMNS = "60";
    expect(getBarWidth()).toBe(6);
    process.env.COLUMNS = "99";
    expect(getBarWidth()).toBe(6);
  });

  it("unknown width → 10-cell default (injected NaN)", () => {
    expect(getBarWidth(NaN)).toBe(10);
  });

  it("explicit column override buckets deterministically", () => {
    expect(getBarWidth(120)).toBe(10);
    expect(getBarWidth(100)).toBe(10);
    expect(getBarWidth(99)).toBe(6);
    expect(getBarWidth(60)).toBe(6);
    expect(getBarWidth(59)).toBe(4);
    expect(getBarWidth(1)).toBe(4);
  });

  it("renderStatusline gauge cell count tracks the width (120 vs 50)", () => {
    process.env.COLUMNS = "120";
    const wide = strip(
      renderStatusline({ context_window: { used_percentage: 50 } }, baseDeps),
    );
    process.env.COLUMNS = "50";
    const narrow = strip(
      renderStatusline({ context_window: { used_percentage: 50 } }, baseDeps),
    );
    // Wide bar has more gauge cells than the narrow one.
    const cells = (s: string) => (s.match(/[═─]/g) ?? []).length;
    expect(cells(wide)).toBeGreaterThan(cells(narrow));
  });
});

// ── 1.6 — prefer stdin usage over the OAuth API ──────────────────────────────

describe("buildStdinUsage + resolveUsage — prefer stdin over OAuth API", () => {
  it("both used_percentage present → builds usage, no API fetch", async () => {
    let apiCalled = false;
    const fetchApi = async (): Promise<UsageResponse | null> => {
      apiCalled = true;
      return { five_hour: { utilization: 1 } };
    };
    const usage = await resolveUsage(
      { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 55 } },
      fetchApi,
    );
    expect(apiCalled).toBe(false);
    expect(usage).toEqual({
      five_hour: { utilization: 40 },
      seven_day: { utilization: 55 },
    });
  });

  it("missing one window → falls back to the injected API fetch", async () => {
    let apiCalled = false;
    const apiResult: UsageResponse = {
      five_hour: { utilization: 7 },
      seven_day: { utilization: 8 },
    };
    const fetchApi = async (): Promise<UsageResponse | null> => {
      apiCalled = true;
      return apiResult;
    };
    const usage = await resolveUsage({ five_hour: { used_percentage: 40 } }, fetchApi);
    expect(apiCalled).toBe(true);
    expect(usage).toBe(apiResult);
  });

  it("buildStdinUsage returns null unless BOTH windows carry used_percentage", () => {
    expect(buildStdinUsage(undefined)).toBeNull();
    expect(buildStdinUsage({ five_hour: { used_percentage: 40 } })).toBeNull();
    expect(buildStdinUsage({ seven_day: { used_percentage: 55 } })).toBeNull();
    expect(
      buildStdinUsage({
        five_hour: { used_percentage: 40 },
        seven_day: { used_percentage: 55 },
      }),
    ).toEqual({ five_hour: { utilization: 40 }, seven_day: { utilization: 55 } });
  });

  it("stdin-sourced usage renders 5H/7D gauges through renderStatusline", () => {
    const usage = buildStdinUsage({
      five_hour: { used_percentage: 40 },
      seven_day: { used_percentage: 55 },
    });
    const out = renderStatusline(
      {
        rate_limits: {
          five_hour: { used_percentage: 40 },
          seven_day: { used_percentage: 55 },
        },
      },
      { ...baseDeps, usage },
    );
    const s = strip(out);
    expect(s).toContain("5H");
    expect(s).toContain("7D");
    expect(s).toContain("40%");
    expect(s).toContain("55%");
  });
});

// ── 1.6 — suspicious-zero context guard ──────────────────────────────────────

describe("resolveContext — suspicious-zero guard", () => {
  const fixedNow = 1_000_000; // unix seconds
  const detNowDeps = { now: () => fixedNow, nowMs: () => fixedNow * 1000 };

  it("zero + fresh non-zero snapshot restores the cached value", () => {
    const res = resolveContext(
      {
        session_id: "s1",
        context_window: { used_percentage: 0, context_window_size: 200000 },
      },
      {
        ...detNowDeps,
        readSnapshot: () => ({
          used_percentage: 62,
          context_window_size: 200000,
          saved_at: fixedNow - 60,
        }),
      },
    );
    expect(res).toEqual({ usedPct: 62, contextWindowSize: 200000 });
  });

  it("restored value renders remaining (NOT 100%) through renderStatusline", () => {
    const out = renderStatusline(
      { context_window: { used_percentage: 0 } },
      { ...baseDeps, resolvedContext: { usedPct: 62, contextWindowSize: 200000 } },
    );
    const s = strip(out);
    expect(s).toContain("CTX");
    expect(s).toContain("38%"); // 100 - 62 remaining
    expect(s).not.toContain("100%");
  });

  it("zero + no snapshot omits the context value (returns null)", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 0 } },
      { ...detNowDeps, readSnapshot: () => null },
    );
    expect(res).toBeNull();
  });

  it("zero + STALE snapshot (beyond 10-min window) omits", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 0 } },
      {
        ...detNowDeps,
        readSnapshot: () => ({ used_percentage: 62, saved_at: fixedNow - 601 }),
      },
    );
    expect(res).toBeNull();
  });

  it("resolvedContext=null omits the context segment in renderStatusline", () => {
    const out = renderStatusline(
      { context_window: { used_percentage: 0 } },
      { ...baseDeps, resolvedContext: null },
    );
    expect(strip(out)).not.toContain("CTX");
  });

  it("populated (>0) frame refreshes the snapshot and returns the live value", () => {
    const written: { used?: number; savedAt?: number } = {};
    const res = resolveContext(
      {
        session_id: "s1",
        context_window: { used_percentage: 45, context_window_size: 1000000 },
      },
      {
        ...detNowDeps,
        statMtimeMs: () => null, // no existing file → not throttled
        readSnapshot: () => null,
        writeSnapshot: (_p, snap) => {
          written.used = snap.used_percentage;
          written.savedAt = snap.saved_at;
        },
      },
    );
    expect(res).toEqual({ usedPct: 45, contextWindowSize: 1000000 });
    expect(written.used).toBe(45);
    expect(written.savedAt).toBe(fixedNow);
  });

  it("populated frame within the 3s write-throttle does NOT rewrite", () => {
    let writes = 0;
    resolveContext(
      { session_id: "s1", context_window: { used_percentage: 45 } },
      {
        ...detNowDeps,
        statMtimeMs: () => fixedNow * 1000 - 1000, // 1s old → throttled
        writeSnapshot: () => {
          writes++;
        },
      },
    );
    expect(writes).toBe(0);
  });

  it("missing session_id on a zero frame omits without reading a snapshot", () => {
    let reads = 0;
    const res = resolveContext(
      { context_window: { used_percentage: 0 } },
      {
        ...detNowDeps,
        readSnapshot: () => {
          reads++;
          return { used_percentage: 62, saved_at: fixedNow };
        },
      },
    );
    expect(res).toBeNull();
    expect(reads).toBe(0);
  });
});

// ── 1.6 — tokens/sec via transcript byte-growth ──────────────────────────────

describe("getSpeed — transcript byte-growth", () => {
  const base = 100_000; // ms

  it("in-window positive delta → tokens/sec estimate", () => {
    const speed = getSpeed("/t", "s1", {
      statSize: () => 10000,
      readCache: () => ({ fileSize: 2000, timestamp: base }),
      writeCache: () => {},
      nowMs: () => base + 1000, // 1s later, inside the window
    });
    // deltaBytes 8000 → 2000 tokens / 1s = 2000 t/s
    expect(speed).toBe(2000);
  });

  it("first sample (no cache) → null and writes a baseline", () => {
    let wrote = false;
    const speed = getSpeed("/t", "s1", {
      statSize: () => 2000,
      readCache: () => null,
      writeCache: () => {
        wrote = true;
      },
      nowMs: () => base,
    });
    expect(speed).toBeNull();
    expect(wrote).toBe(true);
  });

  it("stale interval (> SPEED_WINDOW_MS) → null and resets baseline", () => {
    let wrote = false;
    const speed = getSpeed("/t", "s1", {
      statSize: () => 10000,
      readCache: () => ({ fileSize: 2000, timestamp: base }),
      writeCache: () => {
        wrote = true;
      },
      nowMs: () => base + 2001,
    });
    expect(speed).toBeNull();
    expect(wrote).toBe(true);
  });

  it("too-short interval (< MIN_DELTA_MS) → null and keeps the baseline", () => {
    let wrote = false;
    const speed = getSpeed("/t", "s1", {
      statSize: () => 10000,
      readCache: () => ({ fileSize: 2000, timestamp: base }),
      writeCache: () => {
        wrote = true;
      },
      nowMs: () => base + 400,
    });
    expect(speed).toBeNull();
    expect(wrote).toBe(false);
  });

  it("non-positive delta (no growth) → null", () => {
    const speed = getSpeed("/t", "s1", {
      statSize: () => 2000,
      readCache: () => ({ fileSize: 2000, timestamp: base }),
      writeCache: () => {},
      nowMs: () => base + 1000,
    });
    expect(speed).toBeNull();
  });

  it("file shrink → null and resets baseline", () => {
    let wrote = false;
    const speed = getSpeed("/t", "s1", {
      statSize: () => 500,
      readCache: () => ({ fileSize: 2000, timestamp: base }),
      writeCache: () => {
        wrote = true;
      },
      nowMs: () => base + 1000,
    });
    expect(speed).toBeNull();
    expect(wrote).toBe(true);
  });

  it("missing transcriptPath / sessionId → null", () => {
    expect(getSpeed(undefined, "s1")).toBeNull();
    expect(getSpeed("/t", undefined)).toBeNull();
  });

  it("renders a ≈Nt/s segment through renderStatusline when speed present", () => {
    const out = renderStatusline({}, { ...baseDeps, speed: 2000 });
    expect(strip(out)).toContain("≈2000t/s");
  });

  it("absent speed renders no throughput segment", () => {
    const out = renderStatusline({}, { ...baseDeps, speed: null });
    expect(strip(out)).not.toContain("t/s");
  });
});
