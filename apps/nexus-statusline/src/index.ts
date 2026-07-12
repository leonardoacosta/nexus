#!/usr/bin/env bun
/**
 * nexus-statusline — Claude Code statusline extension (Bun replacement).
 *
 * Runs on every prompt render. Outputs a compact one-line status to stdout.
 * On any error, outputs empty string — statusline must never crash.
 *
 * Reads CC context from stdin (JSON piped by Claude Code) — canonical payload
 * per https://code.claude.com/docs/en/statusline (2026-07-05). All fields
 * optional; renderer degrades gracefully when any are absent.
 *
 *   {
 *     hook_event_name?: "StatusLine",
 *     session_id?: string,
 *     transcript_path?: string,
 *     cwd?: string,
 *     model?: { id?: string; display_name?: string },
 *     workspace?: {
 *       current_dir?: string,
 *       project_dir?: string,
 *       git_worktree?: string,      // name of the active git worktree, when any
 *     },
 *     version?: string,
 *     output_style?: { name?: string },   // CC sends an object, NOT a bare string
 *     effort?: { level?: string },        // reasoning-effort tier (e.g. "xhigh")
 *     exceeds_200k_tokens?: boolean,      // context has crossed the 200K boundary
 *     cost?: {
 *       total_cost_usd?: number,
 *       total_duration_ms?: number,
 *       total_api_duration_ms?: number,
 *       total_lines_added?: number,
 *       total_lines_removed?: number,
 *     },
 *     context_window?: {
 *       used_percentage?: number,    // CC sends used%, NOT remaining%
 *       context_window_size?: number,
 *     },
 *     rate_limits?: {
 *       five_hour?: { used_percentage?: number; resets_at?: number },   // resets_at = unix seconds
 *       seven_day?: { used_percentage?: number; resets_at?: number },
 *     },
 *   }
 *
 * Environment:
 *   CLAUDE_PROJECT_DIR  — Current project directory (fallback: workspace.project_dir, then cwd)
 */

import { openSync, readSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getLocalAgentUrl } from "./project";
import { modelFamilyLetter, renderStatusline } from "./render";
import { buildStdinUsage, resolveUsage, getAccountDomain } from "./usage";
import { resolveContext } from "./context-guard";
import { writeSessionContext, gcSessionContext } from "./session-context";
import { getSpeed } from "./speed";
import {
  fetchStatusline,
  getRoadmapPulse,
  getSpecsLine,
  getRoadmapLine,
  getDriftLine,
} from "./agent-lines";
import type { CcInput, StatuslineResponse, GitInfo } from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function readStdinInput(): CcInput {
  try {
    const fd = openSync("/dev/stdin", "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = readSync(fd, buf, 0, buf.length, null);
    closeSync(fd);
    if (bytesRead === 0) return {};
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf-8"));
  } catch {
    return {};
  }
}

// ── Git status (local) ───────────────────────────────────────────────────────

export function getGitStatus(dir: string): GitInfo | null {
  try {
    const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!branch) return null;

    const porcelain = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dirty = porcelain.trim().length > 0;

    let ahead = 0;
    try {
      const revOut = execFileSync(
        "git",
        ["-C", dir, "rev-list", "--count", "@{upstream}..HEAD"],
        { encoding: "utf-8", timeout: 500, stdio: ["pipe", "pipe", "pipe"] },
      );
      ahead = parseInt(revOut.trim(), 10) || 0;
    } catch {
      // No upstream
    }

    return { branch, dirty, ahead };
  } catch {
    return null;
  }
}

export type { CcInput, GitInfo, StatuslineResponse, UsageResponse } from "./types";

// Shim re-exports for index.test.ts (deleted in the finalize step per plan 031 Step 9).
export {
  modelFamilyLetter,
  modelEffortToken,
  formatSessionClock,
  getBarWidth,
  renderStatusline,
} from "./render";
export { isBbProject, stripRadarStale, gatePulseLine } from "./project";
export { buildStdinUsage, resolveUsage, polledUsageFromCache } from "./usage";
export { resolveContext } from "./context-guard";
export { sessionContextPath, writeSessionContext, gcSessionContext } from "./session-context";
export { getSpeed } from "./speed";
export {
  getRoadmapPulse,
  formatSpecsLine,
  formatRoadmapLine,
  getSpecsLine,
  getRoadmapLine,
  getDriftLine,
  formatDriftLine,
} from "./agent-lines";

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ccInput = readStdinInput();

  // Project dir resolution: CC workspace.project_dir → CLAUDE_PROJECT_DIR → cwd
  const projectDir =
    ccInput.workspace?.project_dir ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();

  // git is still needed for branch + dirty detection (no CC equivalent yet)
  const git = getGitStatus(projectDir);
  const agentUrl = getLocalAgentUrl();

  // Prefer stdin usage; only fetch the OAuth Usage API (+ credential read) when
  // stdin lacks both rate-limit windows.
  const usagePromise = resolveUsage(ccInput.rate_limits);

  // Parallel fetches: agent statusline, usage (stdin-or-API), account domain
  const [nexusData, usage, accountDomain] = await Promise.all([
    fetchStatusline(agentUrl),
    usagePromise,
    getAccountDomain(),
  ]);

  // Resolve context once, harvest it to the per-pane cache for cc-tmux, then
  // pass the same value to the renderer.
  const resolvedContext = resolveContext(ccInput);
  writeSessionContext(resolvedContext?.usedPct, modelFamilyLetter(ccInput.model), git);
  gcSessionContext();

  const out = renderStatusline(ccInput, {
    git,
    nexusData,
    usage,
    accountDomain,
    projectDir,
    resolvedContext,
    speed: getSpeed(ccInput.transcript_path, ccInput.session_id),
    pulse: getRoadmapPulse(projectDir),
    specsLine: getSpecsLine(projectDir, agentUrl),
    roadmapLine: getRoadmapLine(projectDir, agentUrl),
    driftLine: getDriftLine(projectDir, agentUrl),
  });

  process.stdout.write(out);
}

// Only run main() when invoked as a binary, not when imported by tests.
// Bun.main is the absolute path of the entry-point script; import.meta.path
// is this file's path. They match only when this file IS the entry-point.
if (typeof Bun !== "undefined" && Bun.main === import.meta.path) {
  main().catch(() => {
    // Silent — statusline must never crash
  });
}
