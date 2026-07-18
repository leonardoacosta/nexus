/**
 * Unit tests for nexus-statusline renderer.
 *
 * strip-statusline-to-minimal-segments (E2E batch, task 3.1): rewritten after
 * the API/UI batches stripped render.ts/agent-lines.ts/usage.ts/index.ts down
 * to five segments — @domain, project code, session clock, worktree badge,
 * and the trailing roadmap line. Every fixture/assertion touching a removed
 * segment (session dot, $cost, +N/-M lines, M:<model+effort>, output_style,
 * git-branch/dirty/ahead, ⚡ spec marker, 200K+, CTX gauge, ≈Nt/s speed,
 * 5H/7D gauges, pulse/specs/drift trailing rows) has been deleted along with
 * the now-nonexistent exports (getGitStatus, modelEffortToken, getBarWidth,
 * getSpeed, getRoadmapPulse, getSpecsLine, getDriftLine, formatDriftLine,
 * formatSpecsLine, buildStdinUsage, resolveUsage, polledUsageFromCache).
 *
 * These exercise the pure renderStatusline() function with synthetic CC
 * payloads + dep stubs. The binary entry-point (main) is not exercised here.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";

import { renderStatusline, modelFamilyLetter, formatSessionClock } from "./render";
import { isBbProject, gatePulseLine, stripRadarStale } from "./project";
import { formatRoadmapLine, getRoadmapLine } from "./agent-lines";
import { resolveContext } from "./context-guard";
import { gcSessionContext } from "./session-context";
import type { CcInput } from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
  return s.replace(ANSI, "");
}

const baseDeps = {
  accountDomain: null as string | null,
  projectDir: "/home/nyaptor/dev/nx",
};

// ════════════════════════════════════════════════════════════════════════════
// Minimal-segment contract (strip-statusline-to-minimal-segments)
// ════════════════════════════════════════════════════════════════════════════

describe("renderStatusline — kept segments only", () => {
  it("a full payload renders exactly the five kept segments, none of the removed ones", () => {
    const ccInput: CcInput = {
      hook_event_name: "StatusLine",
      session_id: "sess-1",
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      effort: { level: "xhigh" },
      workspace: { project_dir: "/home/x/dev/nx", git_worktree: "my-feature" },
      cost: { total_duration_ms: 161 * 60_000, total_api_duration_ms: 500 },
      context_window: { used_percentage: 42, context_window_size: 200_000 },
    };
    const deps = {
      accountDomain: "leonardoacosta.dev",
      projectDir: "/home/nyaptor/dev/nx",
      roadmapLine: "agent-lifecycle 40%",
    };
    const out = renderStatusline(ccInput, deps);
    const s = strip(out);
    const [head, ...trailing] = s.split("\n");
    const headParts = head!.split("  ");

    // KEPT: @domain, project code, session clock, worktree badge
    expect(headParts).toEqual(["@leonardoacosta", "nx", "⧗2h41m", "⑂my-feature"]);
    // KEPT: trailing roadmap line
    expect(trailing).toEqual(["agent-lifecycle 40%"]);

    // REMOVED — none of these substrings may appear, even though the payload
    // above carries model/effort/context_window/cost data that used to feed
    // them.
    for (const removed of ["$", "CTX", "5H", "7D", "M:", "200K", "◉", "◌", "⚡", "xhigh", "Opus"]) {
      expect(s).not.toContain(removed);
    }
  });

  it("empty payload {} does not crash, leaks no undefined/null, and shows no removed segment", () => {
    let out = "";
    expect(() => {
      out = renderStatusline({}, baseDeps);
    }).not.toThrow();
    const s = strip(out);
    expect(typeof out).toBe("string");
    for (const forbidden of [
      "undefined",
      "null",
      "$",
      "CTX",
      "5H",
      "7D",
      "M:",
      "200K",
      "◉",
      "◌",
      "⚡",
      "⑂",
      "⧗",
    ]) {
      expect(s).not.toContain(forbidden);
    }
  });
});

// ── Project resolution — no git subprocess ───────────────────────────────────

describe("renderStatusline — project resolution", () => {
  it("workspace.project_dir → basename, ignoring deps.projectDir", () => {
    const ccInput: CcInput = { workspace: { project_dir: "/home/x/dev/oo" } };
    const out = renderStatusline(ccInput, baseDeps);
    const stripped = strip(out);
    expect(stripped).toContain("oo");
    expect(stripped).not.toContain("nx ");
  });

  it("renderStatusline's body contains no execSync / spawnSync / git remote get-url references", async () => {
    // Contract assertion: the renderer must not invoke any subprocess (the
    // git-branch fetch was removed and never depended on by the worktree
    // badge, which reads workspace.git_worktree directly).
    const { readFileSync: readSrc } = await import("node:fs");
    const src = readSrc(new URL("./render.ts", import.meta.url), "utf-8");
    const startIdx = src.indexOf("export function renderStatusline");
    expect(startIdx).toBeGreaterThan(0);
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

// ── Session clock — passive elapsed time (add-attention-guard, kept) ─────────

describe("formatSessionClock — passive elapsed time", () => {
  it("sub-hour renders <M>m", () => {
    expect(formatSessionClock(41 * 60_000)).toBe("41m");
    expect(formatSessionClock(0)).toBe("0m");
    expect(formatSessionClock(59 * 60_000)).toBe("59m");
  });

  it("at and past the hour boundary renders <H>h<MM>m (zero-padded minutes)", () => {
    expect(formatSessionClock(60 * 60_000)).toBe("1h00m");
    expect(formatSessionClock(61 * 60_000)).toBe("1h01m");
    expect(formatSessionClock(161 * 60_000)).toBe("2h41m");
  });

  it("truncates seconds (does not round up)", () => {
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
    const out = renderStatusline({ cost: { total_duration_ms: 161 * 60_000 } }, baseDeps);
    expect(strip(out)).toContain("⧗2h41m");
  });

  it("no duration renders no clock segment", () => {
    expect(strip(renderStatusline({}, baseDeps))).not.toContain("⧗");
  });
});

// ── Worktree badge — decoupled from any git fetch ────────────────────────────

describe("renderStatusline — git_worktree badge", () => {
  it("workspace.git_worktree renders the ⑂ badge", () => {
    const out = renderStatusline({ workspace: { git_worktree: "my-feature" } }, baseDeps);
    expect(strip(out)).toContain("⑂my-feature");
  });

  it("absent git_worktree renders no badge", () => {
    expect(strip(renderStatusline({}, baseDeps))).not.toContain("⑂");
  });
});

// ── Roadmap trailing line (add-bead-proposal-roadmap-surface, kept) ──────────

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

describe("renderStatusline — roadmap trailing line", () => {
  it("roadmapLine renders as a trailing row after the head segments", () => {
    const out = renderStatusline({}, { ...baseDeps, roadmapLine: "agent-lifecycle 40%" });
    const lines = strip(out).split("\n");
    expect(lines).toEqual([lines[0]!, "agent-lifecycle 40%"]);
  });

  it("null/absent roadmapLine renders no trailing row", () => {
    const withNull = renderStatusline({}, { ...baseDeps, roadmapLine: null });
    expect(strip(withNull).split("\n")).toHaveLength(1);
    const absent = renderStatusline({}, baseDeps);
    expect(strip(absent).split("\n")).toHaveLength(1);
  });
});

describe("getRoadmapLine — stale-while-revalidate cache", () => {
  it("first render (no cache) returns null and spawns a detached refresh", () => {
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      expect(getRoadmapLine("/home/nyaptor/dev/zzznope", "http://localhost:7400")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]?.[1] as string[];
      expect(args.join(" ")).toContain("/roadmap?project=zzznope");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("readCachedAgentJson (via getRoadmapLine) — refresh spawn carries url/cachePath positionally", () => {
  it("script text is the exact constant; url and cachePath arrive as positional args, never interpolated", () => {
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      expect(
        getRoadmapLine("/home/nyaptor/dev/zzznope-spawn-test", "http://localhost:7400"),
      ).toBeNull();
      const args = spy.mock.calls[0]?.[1] as string[];
      expect(args[1]).toBe(
        'curl -sf --max-time 3 "$1" > "${2}.$$.tmp" 2>/dev/null && mv "${2}.$$.tmp" "$2" || rm -f "${2}.$$.tmp"',
      );
      expect(args[3]).toBe("http://localhost:7400/roadmap?project=zzznope-spawn-test");
      expect(args[4]).toContain("bead-roadmap.zzznope-spawn-test.json");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses a $$-suffixed tmp path with rm -f cleanup (pid-unique, no interleave)", () => {
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      getRoadmapLine("/home/nyaptor/dev/zzznope-pidtmp-curl", "http://localhost:7400");
      const args = spy.mock.calls[0]?.[1] as string[];
      const script = args[1] as string;
      expect(script).toContain(".$$.tmp");
      expect(script).toContain("rm -f");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("readCachedAgentJson — corrupt-fresh cache triggers refresh (via getRoadmapLine)", () => {
  it("a fresh-mtime but unparseable cache still returns null and fires a refresh", () => {
    const stateDir = join(homedir(), ".claude/scripts/state");
    mkdirSync(stateDir, { recursive: true });
    const cachePath = join(stateDir, "bead-roadmap.zzcorrupt.json");
    writeFileSync(cachePath, "{ not json");
    const spy = spyOn(childProcess, "spawn").mockImplementation(
      (() => ({ unref() {} })) as unknown as typeof childProcess.spawn,
    );
    try {
      // FAILS on the stale-before-parse bug: a corrupt-but-fresh mtime cache
      // would otherwise suppress the refresh spawn.
      expect(getRoadmapLine("/home/nyaptor/dev/zzcorrupt", "http://localhost:7400")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      unlinkSync(cachePath);
    }
  });
});

// ── Session-context / context-ctx GC (unaffected infra, kept) ────────────────

describe("gcSessionContext — prunes all three prefixes, honors gate and TTL", () => {
  it("removes aged session-context/statusline-ctx/statusline-speed files, spares fresh + non-owned", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-gc-"));
    try {
      const agedSecs = Date.now() / 1000 - 7 * 3600;
      const aged = [
        join(dir, "session-context.%9.json"),
        join(dir, "statusline-ctx.old.json"),
        join(dir, "statusline-speed.old.json"),
      ];
      for (const p of aged) {
        writeFileSync(p, "{}");
        utimesSync(p, agedSecs, agedSecs);
      }
      const fresh = join(dir, "statusline-ctx.new.json");
      writeFileSync(fresh, "{}");
      const nonOwned = join(dir, "usage-cache.json");
      writeFileSync(nonOwned, "{}");
      utimesSync(nonOwned, agedSecs, agedSecs);

      gcSessionContext({ dir, random: () => 0 });

      for (const p of aged) {
        expect(() => readFileSync(p)).toThrow();
      }
      expect(() => readFileSync(fresh)).not.toThrow();
      expect(() => readFileSync(nonOwned)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the 1-in-100 gate skips the scan when the random source misses", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-gc-gate-"));
    try {
      const agedSecs = Date.now() / 1000 - 7 * 3600;
      const p = join(dir, "session-context.old.json");
      writeFileSync(p, "{}");
      utimesSync(p, agedSecs, agedSecs);

      gcSessionContext({ dir, random: () => 0.5 });

      expect(() => readFileSync(p)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── modelFamilyLetter re-export (kept for future local import sites) ─────────

describe("modelFamilyLetter — shared re-export still resolves from render.ts", () => {
  it("derives the family letter for a known model id", () => {
    expect(modelFamilyLetter({ id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" })).toBe("S");
  });

  it("no model → null", () => {
    expect(modelFamilyLetter(undefined)).toBeNull();
    expect(modelFamilyLetter({})).toBeNull();
  });
});

// ── B&B radar gate (project.ts, untouched by this proposal — still live) ─────

describe("isBbProject + radar gate", () => {
  it("nx (non-B&B) strips radar:stale from the counts row, leaving 7o", () => {
    const isBb = isBbProject("/home/nyaptor/dev/nx");
    expect(isBb).toBe(false);
    expect(gatePulseLine("next: x\n7o,radar:stale", isBb)).toBe("next: x\n7o");
  });

  it("ws (allowlist, no toml) keeps radar:stale", () => {
    const isBb = isBbProject("/home/nyaptor/dev/ws");
    expect(isBb).toBe(true);
    expect(gatePulseLine("next: x\n7o,radar:stale", isBb)).toBe("next: x\n7o,radar:stale");
  });

  it("org = \"bb\" toml overrides a non-allowlisted code", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-bbgate-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude/project.toml"),
        '[project]\nname = "Personalish"\ncode = "zz"\norg = "bb"\n',
      );
      expect(isBbProject(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("org = \"personal\" toml overrides an allowlisted-style code to non-B&B", () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-bbgate-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude/project.toml"), '[project]\norg = "personal"\n');
      expect(isBbProject(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unreadable/absent toml falls back to allowlist without throwing", () => {
    expect(() => isBbProject("/nonexistent/path/xx")).not.toThrow();
    expect(isBbProject("/nonexistent/path/xx")).toBe(false);
  });

  it("stripRadarStale drops a counts row that becomes empty", () => {
    expect(stripRadarStale("next: x\nradar:stale")).toBe("next: x");
    expect(stripRadarStale("radar:stale")).toBe("");
  });

  it("gatePulseLine returns null when non-B&B strip empties the whole line", () => {
    expect(gatePulseLine("radar:stale", false)).toBeNull();
  });
});

// ── resolveContext — suspicious-zero guard (context-guard.ts, kept infra) ────
//
// context-guard.ts's resolveContext is explicitly NOT removed (task 1.4): its
// resolved value still feeds the separate, unchanged "push resolved context
// to nx-agent" requirement. Only the render-facing CTX gauge call site in
// render.ts is gone, so only the renderStatusline-based subtests below were
// dropped — the resolveContext() unit contract itself is unchanged.

describe("resolveContext — suspicious-zero guard", () => {
  const fixedNow = 1_000_000; // unix seconds
  const detNowDeps = { now: () => fixedNow, nowMs: () => fixedNow * 1000 };

  it("zero + fresh non-zero snapshot restores the cached value", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 0, context_window_size: 200000 } },
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

  it("populated (>0) frame refreshes the snapshot and returns the live value", () => {
    const written: { used?: number; savedAt?: number } = {};
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 45, context_window_size: 1000000 } },
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

describe("resolveContext — pushes the RESOLVED value, non-blocking", () => {
  const fixedNow = 1_000_000; // unix seconds
  const detNowDeps = { now: () => fixedNow, nowMs: () => fixedNow * 1000 };

  it("populated frame makes no network call (push removed) and returns the live value", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const res = resolveContext(
        { session_id: "s1", context_window: { used_percentage: 45, context_window_size: 1000000 } },
        { ...detNowDeps, statMtimeMs: () => null, readSnapshot: () => null, writeSnapshot: () => {} },
      );
      expect(res).toEqual({ usedPct: 45, contextWindowSize: 1000000 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("spurious-zero restore returns the snapshot value, NEVER the raw 0 frame, with no network call", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const res = resolveContext(
        { session_id: "s1", context_window: { used_percentage: 0, context_window_size: 200000 } },
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
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does NOT push on a zero frame with no restorable snapshot (omit path)", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 0 } },
      { ...detNowDeps, readSnapshot: () => null },
    );
    expect(res).toBeNull();
  });

  it("returns the guarded value synchronously (fire-and-forget push, never awaited)", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 45, context_window_size: 1000000 } },
      { ...detNowDeps, statMtimeMs: () => null, readSnapshot: () => null, writeSnapshot: () => {} },
    );
    expect(res).toEqual({ usedPct: 45, contextWindowSize: 1000000 });
  });

  it("default push path returns synchronously when fetch never resolves", () => {
    // Exercises the real defaultPushContext: fetch is stubbed to hang, proving
    // the PATCH is not awaited in resolveContext's return path.
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      (() => new Promise<Response>(() => {})) as unknown as typeof fetch, // never resolves
    );
    try {
      const res = resolveContext(
        { session_id: "s1", context_window: { used_percentage: 45, context_window_size: 1000000 } },
        { ...detNowDeps, statMtimeMs: () => null, writeSnapshot: () => {} },
      );
      expect(res).toEqual({ usedPct: 45, contextWindowSize: 1000000 });
    } finally {
      spy.mockRestore();
    }
  });
});

// ── resolveContext — model capture/restore (forward-statusline-model) ───────
//
// CC's `ccInput.model` is captured alongside the context reading so it can be
// forwarded to nx-agent's session-context store via the snapshot file +
// statusline-ctx-poller, instead of relying on the unreliable session_start
// DB path. See context-guard.ts's resolveContext docstring.

describe("resolveContext — model capture/restore", () => {
  const fixedNow = 1_000_000; // unix seconds
  const detNowDeps = { now: () => fixedNow, nowMs: () => fixedNow * 1000 };
  const model = { id: "claude-opus-4-8", display_name: "Opus 4.8" };

  it("populated frame writes ccInput.model into the snapshot and returns it", () => {
    const written: { model?: { id?: string; display_name?: string } } = {};
    const res = resolveContext(
      {
        session_id: "s1",
        model,
        context_window: { used_percentage: 45, context_window_size: 1000000 },
      },
      {
        ...detNowDeps,
        statMtimeMs: () => null,
        readSnapshot: () => null,
        writeSnapshot: (_p, snap) => {
          written.model = snap.model;
        },
      },
    );
    expect(res).toEqual({ usedPct: 45, contextWindowSize: 1000000, model });
    expect(written.model).toEqual(model);
  });

  it("populated frame with no model on ccInput writes/returns model: undefined, no crash", () => {
    const written: { model?: { id?: string; display_name?: string } } = { model: model };
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 45 } },
      {
        ...detNowDeps,
        statMtimeMs: () => null,
        readSnapshot: () => null,
        writeSnapshot: (_p, snap) => {
          written.model = snap.model;
        },
      },
    );
    expect(res?.model).toBeUndefined();
    expect(written.model).toBeUndefined();
  });

  it("spurious-zero restore carries the previously-saved model forward", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 0, context_window_size: 200000 } },
      {
        ...detNowDeps,
        readSnapshot: () => ({
          used_percentage: 62,
          context_window_size: 200000,
          saved_at: fixedNow - 60,
          model,
        }),
      },
    );
    expect(res).toEqual({ usedPct: 62, contextWindowSize: 200000, model });
  });

  it("restore from a pre-existing snapshot with no model field (backward compat) does not crash", () => {
    const res = resolveContext(
      { session_id: "s1", context_window: { used_percentage: 0 } },
      {
        ...detNowDeps,
        // Simulates an on-disk snapshot written before this field existed.
        readSnapshot: () => ({ used_percentage: 62, saved_at: fixedNow - 60 }),
      },
    );
    expect(res).toEqual({ usedPct: 62, contextWindowSize: undefined, model: undefined });
  });
});
