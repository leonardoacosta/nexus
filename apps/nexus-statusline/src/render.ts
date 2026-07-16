import { basename } from "node:path";
import { deriveProjectCode } from "./project";
import type { CcInput } from "./types";

// ── ANSI colors ──────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const PROJ = "\x1b[38;5;117m"; // sky blue
const SPEC = "\x1b[38;5;216m"; // salmon
const DIM = "\x1b[38;5;240m"; // gray

// `modelFamilyLetter` lives in `@nexus/core` (add-session-model-authority) — one
// canonical mapping shared with the agent's `/statusline` route. Re-exported so
// existing local import sites (`./render`) keep resolving it without reaching
// across packages, even though this module's own row-one model token
// (`modelEffortToken`) was removed by strip-statusline-to-minimal-segments.
export { modelFamilyLetter } from "@nexus/core";

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

// ── Renderer (pure, testable) ────────────────────────────────────────────────

export interface RenderDeps {
  /** Account domain from OAuth profile cache; may be null. */
  accountDomain: string | null;
  /** Project directory used for fallback project-code derivation. */
  projectDir: string;
  /** Least-complete capability line (add-bead-proposal-roadmap-surface); null = omit. */
  roadmapLine?: string | null;
}

/**
 * Build the statusline string from a CC payload + ambient deps.
 *
 * Project-name resolution (task 1.8):
 *   1. ccInput.workspace.project_dir → basename
 *   2. fallback to deriveProjectCode(projectDir)
 */
export function renderStatusline(ccInput: CcInput, deps: RenderDeps): string {
  const { accountDomain, projectDir } = deps;

  // Project name: prefer CC payload, fall back to derived
  const projectCode = ccInput.workspace?.project_dir
    ? basename(ccInput.workspace.project_dir)
    : deriveProjectCode(projectDir);

  const parts: string[] = [];

  // Account domain
  if (accountDomain) {
    const short = accountDomain.split(".")[0] ?? accountDomain;
    parts.push(`${DIM}@${short}${RESET}`);
  }

  // Project code (from CC workspace.project_dir or fallback)
  parts.push(`${PROJ}${projectCode}${RESET}`);

  // Session clock — passive elapsed time from session start (add-attention-guard).
  // Plain DIM text, no thresholds / color escalation at any duration.
  const sessionClock = formatSessionClock(ccInput.cost?.total_duration_ms);
  if (sessionClock) {
    parts.push(`${DIM}⧗${sessionClock}${RESET}`);
  }

  // Worktree badge — disambiguates which pane is which when many parallel
  // /apply worktrees are running. Derived directly from workspace.git_worktree;
  // never depended on the (now-removed) git-branch fetch.
  const worktree = ccInput.workspace?.git_worktree;
  if (worktree) {
    parts.push(`${DIM}⑂${worktree}${RESET}`);
  }

  // Trailing line: the roadmap line (least-complete capability). Optional —
  // absent contributes no row.
  const trailing: string[] = [];
  if (deps.roadmapLine) trailing.push(`${SPEC}${deps.roadmapLine}${RESET}`);

  const head = parts.join("  ");
  return trailing.length > 0 ? `${head}\n${trailing.join("\n")}` : head;
}
