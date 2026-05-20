/**
 * Filesystem-driven snapshot construction for the spec-watcher.
 *
 * Replaces the prior `openspec list --json` subprocess dependency with a
 * pure-filesystem walker. Every value emitted here can be derived from
 * `<spec>/proposal.md|design.md|tasks.md` alone — no external CLI required.
 *
 * Split out of `parser.ts` to keep that file under the 250-line ceiling
 * enforced by `line-count.test.ts`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SpecSnapshot } from "./parser";

// ---------------------------------------------------------------------------
// tasks.md checkbox counting
// ---------------------------------------------------------------------------

/**
 * Count completed and total checkbox lines in a `tasks.md` file.
 *
 * Counted line shape: lines starting with `- [ ]` or `- [x]` (case-insensitive
 * on the `x`). Lines with deferral annotations like `- [ ] [DEFERRED]` still
 * count as incomplete; the per-CORE.md ban on deferral applies at the agent
 * orchestration layer, not the parser.
 *
 * Returns `{ completed: 0, total: 0 }` when the file is missing or unreadable.
 */
export function parseTaskCounts(tasksPath: string): {
  completed: number;
  total: number;
} {
  let raw: string;
  try {
    raw = readFileSync(tasksPath, "utf-8");
  } catch {
    return { completed: 0, total: 0 };
  }

  let completed = 0;
  let total = 0;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*-\s+\[( |x|X)\]/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== " ") completed += 1;
  }

  return { completed, total };
}

// ---------------------------------------------------------------------------
// SpecSnapshot construction
// ---------------------------------------------------------------------------

/**
 * Build a SpecSnapshot for a single change-proposal directory by inspecting
 * the filesystem only — no `openspec` CLI invocation.
 *
 * `specDir` should be the absolute path to `<project>/openspec/changes/<spec>/`.
 * `specName` defaults to the directory's basename when omitted.
 *
 * Populated fields:
 *   - `name`: spec dir basename
 *   - `status`: derived from completedTasks vs totalTasks (active / complete)
 *   - `completedTasks` / `totalTasks`: from tasks.md grep
 *   - `lastModified`: ISO-8601 mtime of the spec dir (most recent edit)
 *   - `has_proposal` / `has_design` / `has_tasks`: existsSync tri-state
 *
 * Returns null when `specDir` itself doesn't exist.
 */
export function parseSpecFromPath(
  specDir: string,
  specName?: string,
): SpecSnapshot | null {
  if (!existsSync(specDir)) return null;

  // Always derive `name` from the directory unless an explicit override was
  // passed (kept for symmetry with parseSpecList which reads `name` from JSON).
  const name =
    specName ??
    specDir.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() ??
    "";
  if (!name) return null;

  const proposalPath = join(specDir, "proposal.md");
  const designPath = join(specDir, "design.md");
  const tasksPath = join(specDir, "tasks.md");

  const has_proposal = existsSync(proposalPath);
  const has_design = existsSync(designPath);
  const has_tasks = existsSync(tasksPath);

  const { completed, total } = has_tasks
    ? parseTaskCounts(tasksPath)
    : { completed: 0, total: 0 };

  let lastModified: string | undefined;
  try {
    const st = statSync(specDir);
    lastModified = st.mtime.toISOString();
  } catch {
    lastModified = undefined;
  }

  // Status heuristic: pure-fs scan has no archive/draft signal beyond the
  // file presence, so we derive a coarse three-bucket status:
  //   - "complete" when tasks.md exists and every checkbox is checked
  //   - "active" otherwise (the dir is under changes/, so it's not archived)
  let status = "active";
  if (has_tasks && total > 0 && completed === total) {
    status = "complete";
  }

  return {
    name,
    status,
    completedTasks: completed,
    totalTasks: total,
    lastModified,
    has_proposal,
    has_design,
    has_tasks,
  };
}
