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
 *   }
 *
 * Environment:
 *   CLAUDE_PROJECT_DIR  — Current project directory (fallback: workspace.project_dir, then cwd)
 */

import { readFileSync } from "node:fs";
import { getLocalAgentUrl } from "./project";
import { renderStatusline } from "./render";
import { getAccountDomain } from "./usage";
import { resolveContext } from "./context-guard";
import { gcSessionContext } from "./session-context";
import { getRoadmapLine } from "./agent-lines";
import type { CcInput } from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function readStdinInput(): CcInput {
  try {
    // Read fd 0 directly rather than reopening it via the "/dev/stdin" path.
    // CC invokes this command with stdin as a non-reopenable descriptor type
    // (confirmed via live capture: openSync("/dev/stdin") throws
    // `ENXIO: no such device or address` under a real CC-spawned invocation,
    // even though the already-open fd 0 itself reads fine) — the magic
    // /proc/self/fd/0 symlink reopen only works reliably for plain anonymous
    // pipes, not every stdio descriptor a process launcher may hand a child.
    // readFileSync(0, ...) reads the already-open descriptor in a loop until
    // EOF, with no reopen involved, so it works regardless of descriptor type.
    const raw = readFileSync(0, "utf-8");
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ccInput = readStdinInput();

  // Project dir resolution: CC workspace.project_dir → CLAUDE_PROJECT_DIR → cwd
  const projectDir =
    ccInput.workspace?.project_dir ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();

  const agentUrl = getLocalAgentUrl();

  const accountDomain = await getAccountDomain();

  // Resolve context once (side-effecting: refreshes the per-session snapshot
  // file nx-agent's statusline-ctx-poller reads on its own interval — see
  // context-guard.ts). The render-facing CTX gauge that used to consume the
  // return value was removed; the resolve call itself still must run. The GC
  // below still sweeps pre-existing orphaned pane-keyed files.
  resolveContext(ccInput);
  gcSessionContext();

  const out = renderStatusline(ccInput, {
    accountDomain,
    projectDir,
    roadmapLine: getRoadmapLine(projectDir, agentUrl),
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
