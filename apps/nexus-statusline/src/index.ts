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

import {
  readFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveProjectCode, isBbProject, gatePulseLine, getLocalAgentUrl } from "./project";
import { modelFamilyLetter, renderStatusline } from "./render";
import { FETCH_TIMEOUT_MS, buildStdinUsage, resolveUsage, getAccountDomain } from "./usage";
import { resolveContext } from "./context-guard";
import { writeSessionContext, gcSessionContext } from "./session-context";
import { getSpeed } from "./speed";
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

// ── Agent fetch ──────────────────────────────────────────────────────────────

async function fetchStatusline(agentUrl: string): Promise<StatuslineResponse | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${agentUrl}/statusline`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return (await resp.json()) as StatuslineResponse;
  } catch {
    return null;
  }
}

// ── Roadmap pulse (cc advisor-plans/026) ─────────────────────────────────────

const PULSE_CACHE_TTL_MS = 300_000; // 5 minutes
const PULSE_BIN = join(homedir(), ".claude/scripts/bin/roadmap-pulse");

// Constant refresh script — values arrive as positional shell parameters
// ($1 = binary, $2 = cache path), never interpolated into the script text,
// so shell metacharacters in paths are inert. $0 is set to "sh" by the
// extra argv entry. Preserves the detached atomic `> tmp && mv` idiom. `$$`
// (the spawned shell's pid) suffixes the tmp path so two concurrent CC
// sessions refreshing the same per-project cache never interleave into one
// shared tmp file; `|| rm -f` cleans up the tmp on producer failure (the `>`
// redirect creates it even when the command fails).
const PULSE_REFRESH_SCRIPT =
  '"$1" --line > "${2}.$$.tmp" 2>/dev/null && mv "${2}.$$.tmp" "$2" || rm -f "${2}.$$.tmp"';

/**
 * Read the roadmap-pulse segment for a project, stale-while-revalidate.
 *
 * roadmap-pulse --line takes ~1.4s (bd/openspec scans) — far too slow to run
 * inline on a per-prompt render. So: always serve the cached line (per-project
 * file, mtime = freshness) and, when stale, kick off a detached background
 * refresh for a future render. First-ever render shows nothing; that's fine.
 * Output is project-dependent (openspec/ scan of the repo), hence the
 * per-project cache file and cwd on the refresh spawn.
 */
export function getRoadmapPulse(projectDir: string): string | null {
  try {
    const projectCode = deriveProjectCode(projectDir);
    const isBb = isBbProject(projectDir);
    const cachePath = join(
      homedir(),
      `.claude/scripts/state/roadmap-pulse.${projectCode}.line`,
    );

    let line: string | null = null;
    let stale = true;
    try {
      stale = Date.now() - statSync(cachePath).mtimeMs > PULSE_CACHE_TTL_MS;
      line = readFileSync(cachePath, "utf-8").trim() || null;
    } catch {
      // No cache yet
    }

    if (stale) {
      const child = childProcess.spawn(
        "sh",
        ["-c", PULSE_REFRESH_SCRIPT, "sh", PULSE_BIN, cachePath],
        {
          cwd: projectDir,
          detached: true,
          stdio: "ignore",
          // Producer-side radar gate: cc's roadmap-pulse skips radar rungs when 0
          env: { ...process.env, PULSE_RADAR: isBb ? "1" : "0" },
        },
      );
      child.unref();
    }

    // "Nothing pending." is the script's empty state — not worth a segment
    if (line === "Nothing pending.") return null;
    // Non-B&B: strip the radar:stale counts token (covers the stale-cache window
    // and roadmap-pulse versions predating PULSE_RADAR support).
    return gatePulseLine(line, isBb);
  } catch {
    return null;
  }
}

// ── Bead / roadmap surface lines (add-bead-proposal-roadmap-surface) ─────────

const BEAD_LINE_CACHE_TTL_MS = 300_000; // 5 minutes — same TTL as the pulse cache

// Constant curl-refresh script — $1 = url, $2 = cache path, positional only.
// `curl -f` + `&&` means a down/erroring agent leaves the cache untouched.
// `$$`-suffixed tmp path (see PULSE_REFRESH_SCRIPT) + `|| rm -f` cleanup on
// failure closes the same shared-tmp race for this refresh spawn.
const CURL_REFRESH_SCRIPT =
  'curl -sf --max-time 3 "$1" > "${2}.$$.tmp" 2>/dev/null && mv "${2}.$$.tmp" "$2" || rm -f "${2}.$$.tmp"';

/** Task-count block shared by every bead rollup (agent wire shape). */
interface WireBeadRollup {
  tasks: { total: number; closed: number; ready: number; blocked: number };
}

/** One `/specs/all` row (only the fields the specs line reads). */
interface SpecsAllRow {
  name: string;
  status: string;
  beadRollup?: WireBeadRollup | null;
}

/** `/specs/all` payload (only the fields the specs line reads). */
interface SpecsAllResponse {
  projects?: Array<{ code: string; specs: SpecsAllRow[] }>;
}

/** One `/roadmap` capability (only the fields the roadmap line reads). */
interface RoadmapCapabilityRow {
  name: string;
  progress: { totalTasks: number; closedTasks: number };
}

/** `/roadmap?project=<code>` payload (only the fields the roadmap line reads). */
interface RoadmapResponse {
  capabilities?: RoadmapCapabilityRow[];
}

/**
 * Specs line: the top in-progress proposal for `projectCode`, rendered
 * `<name> <closed>/<total> · <ready> ready`. "Top" = the active proposal with
 * the most task activity (most closed task beads; tie-break by total). A
 * proposal is a candidate only when it is not `complete` and has a non-null
 * rollup with `tasks.total > 0` (otherwise `closed/total · ready` is
 * meaningless). Returns null when nothing qualifies — line omitted.
 */
export function formatSpecsLine(
  projects: Array<{ code: string; specs: SpecsAllRow[] }> | undefined,
  projectCode: string,
): string | null {
  if (!projects) return null;
  const proj = projects.find((p) => p.code === projectCode);
  if (!proj) return null;

  const candidates = proj.specs.filter(
    (s) => s.status !== "complete" && s.beadRollup != null && s.beadRollup.tasks.total > 0,
  );
  if (candidates.length === 0) return null;

  let top = candidates[0]!;
  for (const s of candidates) {
    const a = s.beadRollup!.tasks;
    const t = top.beadRollup!.tasks;
    if (a.closed > t.closed || (a.closed === t.closed && a.total > t.total)) {
      top = s;
    }
  }

  const { closed, total, ready } = top.beadRollup!.tasks;
  return `${top.name} ${closed}/${total} · ${ready} ready`;
}

/**
 * Roadmap line: the least-complete capability, rendered `<name> <pct>%` where
 * `pct` is completion (`closedTasks/totalTasks`). Only capabilities with
 * `totalTasks > 0` are eligible. Returns null when none qualify — line omitted.
 */
export function formatRoadmapLine(
  capabilities: RoadmapCapabilityRow[] | undefined,
): string | null {
  if (!capabilities || capabilities.length === 0) return null;

  const withTasks = capabilities.filter((c) => c.progress.totalTasks > 0);
  if (withTasks.length === 0) return null;

  let least = withTasks[0]!;
  let leastRatio = least.progress.closedTasks / least.progress.totalTasks;
  for (const c of withTasks) {
    const r = c.progress.closedTasks / c.progress.totalTasks;
    if (r < leastRatio) {
      least = c;
      leastRatio = r;
    }
  }

  return `${least.name} ${Math.round(leastRatio * 100)}%`;
}

/**
 * Read a cached agent JSON payload, stale-while-revalidate. Identical
 * mechanism to `getRoadmapPulse`: serve the cached file (mtime = freshness)
 * and, when stale, kick off a detached `curl` refresh that writes the raw
 * agent response to the cache for a future render. `curl -f` + `&&` means a
 * down/erroring agent leaves the cache untouched (stays stale → retried next
 * render) rather than clobbering it with an empty file. First-ever render
 * returns null (empty on first render — no blocking).
 */
function readCachedAgentJson<T>(cachePath: string, url: string): T | null {
  let data: T | null = null;
  let stale = true;
  try {
    stale = Date.now() - statSync(cachePath).mtimeMs > BEAD_LINE_CACHE_TTL_MS;
    data = JSON.parse(readFileSync(cachePath, "utf-8")) as T;
  } catch {
    // No cache yet / unparseable — treat as stale, return null.
    stale = true; // a corrupt-but-fresh cache must still trigger a refresh
  }

  if (stale) {
    const child = childProcess.spawn(
      "sh",
      ["-c", CURL_REFRESH_SCRIPT, "sh", url, cachePath],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  return data;
}

/**
 * Specs line for the statusline, sourced from the agent's `GET /specs/all`
 * behind the stale-while-revalidate cache. Empty on first render.
 */
export function getSpecsLine(projectDir: string, agentUrl: string): string | null {
  try {
    const code = deriveProjectCode(projectDir);
    const cachePath = join(
      homedir(),
      `.claude/scripts/state/bead-specs.${code}.json`,
    );
    const data = readCachedAgentJson<SpecsAllResponse>(cachePath, `${agentUrl}/specs/all`);
    return formatSpecsLine(data?.projects, code);
  } catch {
    return null;
  }
}

/**
 * Roadmap line for the statusline, sourced from the agent's
 * `GET /roadmap?project=<code>` behind the stale-while-revalidate cache.
 * Empty on first render.
 */
export function getRoadmapLine(projectDir: string, agentUrl: string): string | null {
  try {
    const code = deriveProjectCode(projectDir);
    const cachePath = join(
      homedir(),
      `.claude/scripts/state/bead-roadmap.${code}.json`,
    );
    const data = readCachedAgentJson<RoadmapResponse>(
      cachePath,
      `${agentUrl}/roadmap?project=${code}`,
    );
    return formatRoadmapLine(data?.capabilities);
  } catch {
    return null;
  }
}

// ── Attention guard: foreign high-urgency queue head (add-attention-guard) ───

/**
 * The mx triage verdict attached to a queue item — the fields the drift line
 * reads. Mirrors NexusShared `Verdict` (TriageItem.swift): `confidence` is a
 * numeric score (0…1) when present, else a band string arrives under
 * `confidenceBand` / `confidence_band` / `confidenceLabel`.
 */
interface QueueVerdict {
  action?: string;
  confidence?: number;
  confidenceBand?: string;
  confidence_band?: string;
  confidenceLabel?: string;
}

/**
 * One `/queue` item — the fields the drift line reads. The mx gateway emits
 * protojson (nested `core`) OR a flattened spine; we tolerate BOTH by probing
 * `core` first, exactly like the NexusShared `TriageItem` decoder.
 */
interface QueueItem {
  source?: string;
  title?: string;
  verdict?: QueueVerdict | null;
  core?: { source?: string; title?: string };
}

/** `/queue` payload (only the field the drift line reads). */
interface QueueResponse {
  items?: QueueItem[];
}

/**
 * Banded confidence for a queue verdict, mirroring NexusShared
 * `Verdict.confidenceBand`: prefer the numeric score (≥0.75 high, ≥0.40
 * medium, else low), falling back to the raw band/label string lowercased.
 * null when neither is present.
 */
function verdictBand(v: QueueVerdict): string | null {
  if (typeof v.confidence === "number" && Number.isFinite(v.confidence)) {
    if (v.confidence >= 0.75) return "high";
    if (v.confidence >= 0.4) return "medium";
    return "low";
  }
  const raw = v.confidenceBand ?? v.confidence_band ?? v.confidenceLabel;
  return raw ? raw.toLowerCase() : null;
}

/**
 * Drift line for the statusline: renders `head: <action> — <title> (<source>)`
 * for the queue head ONLY when its verdict is a preempt-action OR high-confidence
 * AND its request belongs to a project OTHER than the current session's. Returns
 * null (silent) on same-project heads, lower-urgency heads, verdict-less heads,
 * empty queues, and — via the caller — fetch failures. `currentCode` is the
 * statusline's own project code (cwd/project input); comparison is
 * case-insensitive.
 */
export function formatDriftLine(
  items: QueueItem[] | undefined,
  currentCode: string,
): string | null {
  if (!items || items.length === 0) return null;
  const head = items[0];
  if (!head) return null;

  const verdict = head.verdict;
  if (!verdict) return null;

  const action = verdict.action?.toLowerCase() ?? "";
  const isPreempt = action === "preempt";
  const isHighConfidence = verdictBand(verdict) === "high";
  if (!isPreempt && !isHighConfidence) return null;

  const source = (head.core?.source ?? head.source ?? "").trim();
  if (!source) return null;
  // Foreign-project gate: silent when the head belongs to the current project.
  if (source.toLowerCase() === currentCode.toLowerCase()) return null;

  const title = (head.core?.title ?? head.title ?? "").trim();
  const actionLabel = verdict.action?.trim() || "head";
  return `head: ${actionLabel} — ${title} (${source})`;
}

/**
 * Drift line sourced from the agent's `GET /queue?limit=1` behind the same
 * stale-while-revalidate cache the specs/roadmap lines use. Empty on first
 * render; silent on fetch failure (a down agent leaves the cache untouched, so
 * `readCachedAgentJson` returns null → no line).
 */
export function getDriftLine(projectDir: string, agentUrl: string): string | null {
  try {
    const code = deriveProjectCode(projectDir);
    const cachePath = join(
      homedir(),
      `.claude/scripts/state/queue-head.${code}.json`,
    );
    const data = readCachedAgentJson<QueueResponse>(
      cachePath,
      `${agentUrl}/queue?limit=1`,
    );
    return formatDriftLine(data?.items, code);
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
