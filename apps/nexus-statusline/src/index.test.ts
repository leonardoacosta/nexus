/**
 * Unit tests for nexus-statusline renderer.
 *
 * These exercise the pure renderStatusline() function with synthetic CC
 * payloads + dep stubs. The binary entry-point (main) is not exercised here;
 * it's covered by the section-3 smoke test (`echo '{}' | nexus-statusline`).
 */

import { describe, expect, it } from "bun:test";

import { renderStatusline, type CcInput } from "./index";

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
  it("[2.1] renders a context-bar segment when canonical payload supplied", () => {
    const ccInput: CcInput = {
      hook_event_name: "StatusLine",
      session_id: "abc",
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      workspace: { current_dir: "/home/x/dev/nx", project_dir: "/home/x/dev/nx" },
      context_window: { used_percentage: 45, used_tokens: 45000, max_tokens: 1_000_000 },
    };
    const out = renderStatusline(ccInput, baseDeps);
    const stripped = strip(out);
    // Renders "CTX" gauge with 55% remaining
    expect(stripped).toContain("CTX");
    expect(stripped).toContain("55%");
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
  it("[2.8a] output_style='tts-summary' renders an 8-char truncation", () => {
    const ccInput: CcInput = { output_style: "tts-summary" };
    const out = renderStatusline(ccInput, baseDeps);
    const stripped = strip(out);
    // Truncates to head before dash → "tts" (≤ 8 chars)
    expect(stripped).toContain("tts");
    // Must not contain full string (the truncation must actually fire)
    expect(stripped).not.toContain("tts-summary");
  });

  it("[2.8b] output_style='default' renders nothing (no segment)", () => {
    const ccInput: CcInput = { output_style: "default" };
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
