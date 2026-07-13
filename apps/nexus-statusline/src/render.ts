import { basename } from "node:path";
import { modelFamilyLetter } from "@nexus/core";
import { nowSecs } from "./cache-io";
import { deriveProjectCode } from "./project";
import type {
  CcInput,
  GitInfo,
  StatuslineResponse,
  UsageResponse,
  ResolvedContext,
} from "./types";

// ── ANSI colors ──────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const PROJ = "\x1b[38;5;117m"; // sky blue
const GIT = "\x1b[38;5;150m"; // soft green
const GIT_DIRTY = "\x1b[38;5;215m"; // peach
const CTX_HIGH = "\x1b[38;5;158m"; // mint   (>40% remaining)
const CTX_MED = "\x1b[38;5;215m"; // orange (20-40% remaining)
const CTX_LOW = "\x1b[38;5;203m"; // red    (<20% remaining)
const SPEC = "\x1b[38;5;216m"; // salmon
const DIM = "\x1b[38;5;240m"; // gray

// ── Model/effort token ────────────────────────────────────────────────────────
//
// `modelFamilyLetter` now lives in `@nexus/core` (add-session-model-authority) —
// one canonical mapping shared with the agent's `/statusline` route. Only the
// effort-suffix half stays local (below). Re-exported so existing local import
// sites (`./render`) keep resolving it without reaching across packages.
export { modelFamilyLetter } from "@nexus/core";

/** Effort-level → compact suffix. `ultracode` mapped defensively alongside `max`. */
const EFFORT_SUFFIX: Readonly<Record<string, string>> = {
  low: "l",
  medium: "m",
  high: "h",
  xhigh: "xh",
  max: "u",
  ultracode: "u",
};

/**
 * Compact row-one model token: family letter (see `modelFamilyLetter`) + effort
 * suffix (`low/medium/high/xhigh/max|ultracode` → `l/m/h/xh/u`). Effort absent
 * or unrecognized → letter alone. No model → no token (effort alone never renders).
 */
export function modelEffortToken(
  model?: { id?: string; display_name?: string },
  effort?: { level?: string },
): string | null {
  const letter = modelFamilyLetter(model);
  if (!letter) return null;

  const level = effort?.level?.toLowerCase();
  const suffix = level ? (EFFORT_SUFFIX[level] ?? "") : "";
  return letter + suffix;
}

/** Truncate output_style name to ≤ 8 chars for statusline display. */
function shortenOutputStyle(style: string): string {
  if (style.length <= 8) return style;
  // Strip suffix after first dash, then truncate to 8
  const head = style.split(/[-_]/)[0] ?? style;
  return head.length <= 8 ? head : head.slice(0, 8);
}

/** Format remaining seconds as countdown ↻Xd, ↻H:MMh, ↻Mm, or ↻now. */
function formatCountdown(remainingSecs: number): string {
  if (remainingSecs <= 0) return "↻now";
  if (remainingSecs >= 86400 * 2) {
    return `↻${Math.floor(remainingSecs / 86400)}d`;
  }
  if (remainingSecs < 3600) {
    return `↻${Math.floor(remainingSecs / 60)}m`;
  }
  const h = Math.floor(remainingSecs / 3600);
  const m = Math.floor((remainingSecs % 3600) / 60);
  return `↻${h}:${String(m).padStart(2, "0")}h`;
}

// ── Session clock: passive elapsed time (add-attention-guard) ────────────────

/**
 * Format session elapsed time as plain text — `<H>h<MM>m` past the first hour
 * (`2h41m`), `<M>m` below it (`41m`). No thresholds, no color escalation, no
 * triggered behavior at any duration — time made visible, nothing more.
 * Returns null for a missing / non-finite / negative duration (no segment).
 */
export function formatSessionClock(durationMs: number | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

// ── Gauge rendering ──────────────────────────────────────────────────────────

/**
 * Adaptive gauge cell count from the terminal width. Reads `COLUMNS` first
 * (integer parse), then `process.stdout.columns`, then `process.stderr.columns`;
 * buckets ≥100→10, ≥60→6, else 4; defaults to 10 when the width is unknown.
 * `colsOverride` (the raw column count) is injectable for deterministic tests;
 * the production call is arg-free.
 */
export function getBarWidth(colsOverride?: number): number {
  let cols: number | undefined;
  if (colsOverride != null && Number.isFinite(colsOverride)) {
    cols = colsOverride;
  } else {
    const envRaw = process.env.COLUMNS;
    const envCols = envRaw != null ? parseInt(envRaw, 10) : NaN;
    if (Number.isFinite(envCols) && envCols > 0) {
      cols = envCols;
    } else if (
      typeof process.stdout?.columns === "number" &&
      process.stdout.columns > 0
    ) {
      cols = process.stdout.columns;
    } else if (
      typeof process.stderr?.columns === "number" &&
      process.stderr.columns > 0
    ) {
      cols = process.stderr.columns;
    }
  }
  if (cols == null || !Number.isFinite(cols)) return 10;
  if (cols >= 100) return 10;
  if (cols >= 60) return 6;
  return 4;
}

function renderGauge(label: string, pct: number, suffix: string): string {
  const color = pct <= 20 ? CTX_LOW : pct <= 40 ? CTX_MED : CTX_HIGH;
  const width = getBarWidth();
  const filled = Math.floor((pct * width) / 100);
  const empty = width - filled;
  const bar = "═".repeat(filled) + "─".repeat(empty);
  return `${DIM}${label}${RESET} ${color}${bar} ${suffix}${RESET}`;
}

function renderContext(
  remainingPct: number,
  usedPct?: number,
  contextWindowSize?: number,
): string {
  const pct = Math.round(remainingPct);
  let suffix = `${pct}%`;
  if (
    contextWindowSize != null &&
    contextWindowSize > 0 &&
    usedPct != null
  ) {
    const usedK = Math.round((usedPct / 100) * contextWindowSize / 1000);
    const sizeK = Math.round(contextWindowSize / 1000);
    suffix = `${pct}% ${usedK}k/${sizeK}k`;
  }
  return renderGauge("CTX", pct, suffix);
}

/** Parse ISO8601 timestamp to unix seconds. */
function parseTimestamp(ts: string): number | null {
  const ms = Date.parse(ts);
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}

function projectUtilization(
  current: number,
  windowSecs: number,
  remainingSecs: number,
): number {
  const elapsed = windowSecs - remainingSecs;
  if (elapsed < 60 || current < 0.1) return current;
  const burnRate = current / elapsed;
  return Math.min(burnRate * windowSecs, 999);
}

function momentumIndicator(projected: number): string {
  if (projected < 0.1) return "";
  let arrow: string;
  let color: string;
  if (projected >= 95) {
    arrow = "↑";
    color = CTX_LOW;
  } else if (projected >= 75) {
    arrow = "↗";
    color = CTX_MED;
  } else {
    arrow = "→";
    color = CTX_HIGH;
  }
  return `${color}${arrow}${Math.round(projected)}%${RESET}`;
}

function renderUsageGauge(
  label: string,
  utilization: number,
  resetsAt: string | undefined,
  windowSecs: number,
  /** CC-sourced unix-seconds reset; takes precedence over resetsAt when present. */
  ccResetsAtUnixSecs?: number,
): string {
  const now = nowSecs();
  let remainingSecs = 0;
  if (ccResetsAtUnixSecs != null && Number.isFinite(ccResetsAtUnixSecs)) {
    remainingSecs = Math.max(ccResetsAtUnixSecs - now, 0);
  } else if (resetsAt) {
    remainingSecs = Math.max((parseTimestamp(resetsAt) ?? now) - now, 0);
  }

  const remainingPct = Math.max(100 - utilization, 0);
  const projected = projectUtilization(utilization, windowSecs, remainingSecs);
  const momentum = momentumIndicator(projected);

  const countdown = formatCountdown(remainingSecs);

  const suffix = momentum
    ? `${Math.round(utilization)}% ${momentum} ${countdown}`
    : `${Math.round(utilization)}% ${countdown}`;

  // Color gauge by projected risk
  let gaugePct = remainingPct;
  if (projected >= 95) gaugePct = Math.min(gaugePct, 20);
  else if (projected >= 75) gaugePct = Math.min(gaugePct, 40);

  return renderGauge(label, gaugePct, suffix);
}

// ── Renderer (pure, testable) ────────────────────────────────────────────────

export interface RenderDeps {
  /** Git status for the resolved project dir (null = not a repo / unavailable). */
  git: GitInfo | null;
  /** Result of agent /statusline fetch; may be null on failure. */
  nexusData: StatuslineResponse | null;
  /** Result of Anthropic Usage API fetch; may be null. */
  usage: UsageResponse | null;
  /** Account domain from OAuth profile cache; may be null. */
  accountDomain: string | null;
  /** Project directory used for fallback project-code derivation. */
  projectDir: string;
  /** Cached roadmap-pulse --line output; null/absent = no segment. */
  pulse?: string | null;
  /** Top in-progress proposal line (add-bead-proposal-roadmap-surface); null = omit. */
  specsLine?: string | null;
  /** Least-complete capability line (add-bead-proposal-roadmap-surface); null = omit. */
  roadmapLine?: string | null;
  /** Foreign high-urgency queue-head drift line (add-attention-guard); null = silent. */
  driftLine?: string | null;
  /**
   * Context value resolved by the suspicious-zero guard (`resolveContext`).
   * `undefined` = not resolved by the caller → fall back to raw
   * `ccInput.context_window` (legacy path, used by unit tests). An object
   * renders that value; explicit `null` omits the context segment.
   */
  resolvedContext?: ResolvedContext | null;
  /** tokens/sec estimate (`getSpeed`); null/absent = no throughput segment. */
  speed?: number | null;
}

/**
 * Build the statusline string from a CC payload + ambient deps.
 *
 * Project-name resolution (task 1.8):
 *   1. ccInput.workspace.project_dir → basename
 *   2. fallback to deriveProjectCode(projectDir)
 *
 * No git subprocess is invoked from here — the caller passes pre-resolved git.
 */
export function renderStatusline(ccInput: CcInput, deps: RenderDeps): string {
  const { git, nexusData, usage, accountDomain, projectDir } = deps;

  // Project name: prefer CC payload, fall back to derived
  const projectCode = ccInput.workspace?.project_dir
    ? basename(ccInput.workspace.project_dir)
    : deriveProjectCode(projectDir);

  const session = nexusData?.sessions.find((s) => s.project === projectCode);

  const parts: string[] = [];

  // Session count indicator
  const sessionCount = nexusData?.sessions.length ?? 0;
  if (sessionCount > 1) {
    parts.push(`${DIM}◉${RESET} ${sessionCount}`);
  } else if (sessionCount === 1) {
    parts.push(`${DIM}◉${RESET}`);
  } else {
    parts.push(`${DIM}◌${RESET}`);
  }

  // Account domain
  if (accountDomain) {
    const short = accountDomain.split(".")[0] ?? accountDomain;
    parts.push(`${DIM}@${short}${RESET}`);
  }

  // Project code (from CC workspace.project_dir or fallback)
  parts.push(`${PROJ}${projectCode}${RESET}`);

  // Cost segment (DIM, only when ≥ $0.01) — between project name and 5H segment
  const totalCost = ccInput.cost?.total_cost_usd;
  if (totalCost != null && totalCost >= 0.01) {
    parts.push(`${DIM}$${totalCost.toFixed(2)}${RESET}`);
  }

  // Line-delta segment (DIM, only when both present and at least one nonzero)
  const linesAdded = ccInput.cost?.total_lines_added;
  const linesRemoved = ccInput.cost?.total_lines_removed;
  if (
    linesAdded != null &&
    linesRemoved != null &&
    (linesAdded > 0 || linesRemoved > 0)
  ) {
    parts.push(`${DIM}+${linesAdded}/-${linesRemoved}${RESET}`);
  }

  // Session clock — passive elapsed time from session start (add-attention-guard).
  // Plain DIM text, no thresholds / color escalation at any duration.
  const sessionClock = formatSessionClock(ccInput.cost?.total_duration_ms);
  if (sessionClock) {
    parts.push(`${DIM}⧗${sessionClock}${RESET}`);
  }

  // CC model/effort token + output_style (between project info and git).
  // Combined token (e.g. Fu, Sxh, O) supersedes the old version-number segment
  // and the standalone effort tag.
  const modelToken = modelEffortToken(ccInput.model, ccInput.effort);
  if (modelToken) {
    parts.push(`${DIM}${modelToken}${RESET}`);
  }
  // output_style — CC sends { name } (object). Tolerate the legacy bare-string
  // form defensively so an old payload degrades gracefully instead of crashing.
  const outputStyleRaw = ccInput.output_style as { name?: string } | string | undefined;
  const outputStyle =
    typeof outputStyleRaw === "string" ? outputStyleRaw : outputStyleRaw?.name;
  if (outputStyle && outputStyle !== "default") {
    parts.push(`${DIM}${shortenOutputStyle(outputStyle)}${RESET}`);
  }

  // Git branch
  if (git) {
    let branchPart = git.dirty
      ? `${GIT_DIRTY}${git.branch}*${RESET}`
      : `${GIT}${git.branch}${RESET}`;
    if (git.ahead > 0) {
      branchPart += `  ${DIM}↑${git.ahead}${RESET}`;
    }
    parts.push(branchPart);
  }

  // Worktree badge — immediately after the git branch segment. Disambiguates
  // which pane is which when many parallel /apply worktrees are running.
  const worktree = ccInput.workspace?.git_worktree;
  if (worktree) {
    parts.push(`${DIM}⑂${worktree}${RESET}`);
  }

  // Active spec (from nexus-agent session — spec field may be absent)
  const spec = (session as Record<string, unknown> | undefined)?.spec;
  if (typeof spec === "string" && spec.length > 0) {
    parts.push(`⚡ ${SPEC}${spec}${RESET}`);
  }

  // 200K-boundary marker — compact qualifier immediately before the context bar
  if (ccInput.exceeds_200k_tokens) {
    parts.push(`${DIM}200K+${RESET}`);
  }

  // Context window — CC sends used_percentage; we display remaining.
  // When the caller resolved context via the suspicious-zero guard, honor it:
  // an object renders that value, explicit `null` omits the segment (never the
  // inverted `CTX 100%`). Undefined = legacy raw path (unit tests).
  let ctxUsedPct: number | undefined;
  let ctxSize: number | undefined;
  let ctxOmit = false;
  if (deps.resolvedContext !== undefined) {
    if (deps.resolvedContext === null) {
      ctxOmit = true;
    } else {
      ctxUsedPct = deps.resolvedContext.usedPct;
      ctxSize = deps.resolvedContext.contextWindowSize;
    }
  } else {
    ctxUsedPct = ccInput.context_window?.used_percentage;
    ctxSize = ccInput.context_window?.context_window_size;
  }
  if (!ctxOmit && ctxUsedPct != null) {
    const remaining = 100 - ctxUsedPct;
    parts.push(renderContext(remaining, ctxUsedPct, ctxSize));
  }

  // Live throughput estimate (tokens/sec) — DIM, near the context bar. Absent
  // (null) on any render with no valid byte-growth sample; that is expected.
  if (deps.speed != null) {
    parts.push(`${DIM}≈${Math.round(deps.speed)}t/s${RESET}`);
  }

  // Session (5hr) and Weekly (7d) usage
  if (usage) {
    if (usage.five_hour) {
      // Prefer CC-supplied resets_at (unix seconds) when present (task 1.7)
      const ccResetsAt = ccInput.rate_limits?.five_hour?.resets_at;
      parts.push(
        renderUsageGauge(
          "5H",
          usage.five_hour.utilization,
          usage.five_hour.resets_at,
          5 * 3600,
          ccResetsAt,
        ),
      );
    }
    if (usage.seven_day) {
      // Prefer CC-supplied resets_at (unix seconds) when present, same precedence
      // pattern the 5H segment already uses for five_hour.resets_at.
      const ccResetsAt7d = ccInput.rate_limits?.seven_day?.resets_at;
      parts.push(
        renderUsageGauge(
          "7D",
          usage.seven_day.utilization,
          usage.seven_day.resets_at,
          7 * 86400,
          ccResetsAt7d,
        ),
      );
    }
  }

  // Trailing lines, each on its own row: roadmap pulse ("what's next"), then
  // the specs line (top in-progress proposal), then the roadmap line
  // (least-complete capability). All optional — absent ones contribute no row.
  const trailing: string[] = [];
  // Drift line first — the attention guard is the highest-signal trailing row.
  if (deps.driftLine) trailing.push(`${GIT_DIRTY}${deps.driftLine}${RESET}`);
  if (deps.pulse) trailing.push(`${SPEC}${deps.pulse}${RESET}`);
  if (deps.specsLine) trailing.push(`${SPEC}${deps.specsLine}${RESET}`);
  if (deps.roadmapLine) trailing.push(`${SPEC}${deps.roadmapLine}${RESET}`);

  const head = parts.join("  ");
  return trailing.length > 0 ? `${head}\n${trailing.join("\n")}` : head;
}
