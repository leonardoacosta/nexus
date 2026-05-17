#!/usr/bin/env bun
/**
 * nexus-statusline — Claude Code statusline extension (Bun replacement).
 *
 * Runs on every prompt render. Outputs a compact one-line status to stdout.
 * On any error, outputs empty string — statusline must never crash.
 *
 * Reads CC context from stdin (JSON piped by Claude Code) — canonical payload
 * per https://code.claude.com/docs/en/statusline (2026-04-24). All fields
 * optional; renderer degrades gracefully when any are absent.
 *
 *   {
 *     hook_event_name?: "StatusLine",
 *     session_id?: string,
 *     transcript_path?: string,
 *     cwd?: string,
 *     model?: { id?: string; display_name?: string },
 *     workspace?: { current_dir?: string; project_dir?: string },
 *     version?: string,
 *     output_style?: string,
 *     cost?: {
 *       total_cost_usd?: number,
 *       total_duration_ms?: number,
 *       total_api_duration_ms?: number,
 *       total_lines_added?: number,
 *       total_lines_removed?: number,
 *     },
 *     context_window?: {
 *       used_percentage?: number,    // CC sends used%, NOT remaining%
 *       used_tokens?: number,
 *       max_tokens?: number,
 *     },
 *     rate_limits?: {
 *       five_hour?: { resets_at?: number },  // unix seconds
 *     },
 *   }
 *
 * Environment:
 *   CLAUDE_PROJECT_DIR  — Current project directory (fallback: workspace.project_dir, then cwd)
 */

import { readFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename } from "node:path";

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

// ── Types ────────────────────────────────────────────────────────────────────

interface CcInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  version?: string;
  output_style?: string;
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    used_percentage?: number;
    used_tokens?: number;
    max_tokens?: number;
  };
  rate_limits?: {
    five_hour?: { resets_at?: number };
  };
}

interface StatuslineSession {
  id: string;
  project: string | null;
  status: string;
  model: string | null;
  cwd: string | null;
  idle_seconds: number;
}

interface StatuslineResponse {
  sessions: StatuslineSession[];
  git: { branch: string; dirty: boolean; ahead: number; behind: number } | null;
  machine: { cpu_percent: number; mem_percent: number; load_1m: number };
  uptime_seconds: number;
  daemon_count: number;
}

interface UsagePeriod {
  utilization: number;
  resets_at?: string;
}

interface UsageResponse {
  five_hour?: UsagePeriod;
  seven_day?: UsagePeriod;
}

interface CachedUsage {
  fetched_at: number;
  data: UsageResponse;
}

interface CachedProfile {
  fetched_at: number;
  domain: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 2_000;
const USAGE_CACHE_TTL = 300; // 5 minutes (seconds)
const PROFILE_CACHE_TTL = 3600; // 1 hour (seconds)

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

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

function deriveProjectCode(dir: string): string {
  if (dir.includes("/.claude") || dir.endsWith("/.claude")) return "cc";
  const devIdx = dir.indexOf("/dev/");
  if (devIdx !== -1) {
    const rest = dir.slice(devIdx + 5);
    const end = rest.indexOf("/");
    return end !== -1 ? rest.slice(0, end) : rest;
  }
  return basename(dir) || "?";
}

function shortenModel(model: string): string {
  const parts = model.split(/\s+/);
  return parts[1] ?? model;
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

/** Parse agent URL from agents.toml (simple regex, no TOML dep). */
function getLocalAgentUrl(): string {
  try {
    const tomlPath = join(homedir(), ".config/nexus/agents.toml");
    const content = readFileSync(tomlPath, "utf-8");
    // Find the first [[agents]] block with name matching self_name or "localhost"
    const selfMatch = content.match(/^self_name\s*=\s*"([^"]+)"/m);
    const selfName = selfMatch?.[1] ?? "localhost";

    // Find port for local agent (first agent block, or matching self_name)
    const portMatch = content.match(/port\s*=\s*(\d+)/);
    const port = portMatch?.[1] ?? "7400";

    return `http://localhost:${port}`;
  } catch {
    return "http://localhost:7400";
  }
}

// ── Git status (local) ───────────────────────────────────────────────────────

interface GitInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
}

function getGitStatus(dir: string): GitInfo | null {
  try {
    const branch = execSync(`git -C "${dir}" branch --show-current`, {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!branch) return null;

    const porcelain = execSync(`git -C "${dir}" status --porcelain`, {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dirty = porcelain.trim().length > 0;

    let ahead = 0;
    try {
      const revOut = execSync(
        `git -C "${dir}" rev-list --count @{upstream}..HEAD`,
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

// ── Anthropic Usage API ──────────────────────────────────────────────────────

function readAccessToken(): string | null {
  try {
    const path = join(homedir(), ".claude/.credentials.json");
    const content = readFileSync(path, "utf-8");
    const creds = JSON.parse(content);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    // Check expiry (expiresAt is in milliseconds)
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken as string;
  } catch {
    return null;
  }
}

function usageCachePath(): string {
  return join(homedir(), ".claude/scripts/state/usage-cache.json");
}

function profileCachePath(): string {
  return join(homedir(), ".claude/scripts/state/profile-cache.json");
}

async function fetchWithToken<T>(token: string, endpoint: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const body = (await resp.json()) as T;
    return body;
  } catch {
    return null;
  }
}

async function getApiUsage(): Promise<UsageResponse | null> {
  try {
    const cachePath = usageCachePath();
    // Check cache
    try {
      const content = readFileSync(cachePath, "utf-8");
      const cached: CachedUsage = JSON.parse(content);
      if (nowSecs() - cached.fetched_at < USAGE_CACHE_TTL) return cached.data;
    } catch {
      // Cache miss
    }

    const token = readAccessToken();
    if (!token) return null;

    const fresh = await fetchWithToken<UsageResponse>(
      token,
      "https://api.anthropic.com/api/oauth/usage",
    );
    if (!fresh) return null;

    // Write cache — 0o600 satisfies credential-pool spec requirement for restrictive
    // permissions on cache files (usage-cache.json is low-sensitivity but spec-gated).
    try {
      const cached: CachedUsage = { fetched_at: nowSecs(), data: fresh };
      writeFileSync(cachePath, JSON.stringify(cached), { mode: 0o600 });
    } catch {
      // Non-fatal
    }

    return fresh;
  } catch {
    return null;
  }
}

async function getAccountDomain(): Promise<string | null> {
  try {
    const cachePath = profileCachePath();
    // Check cache
    try {
      const content = readFileSync(cachePath, "utf-8");
      const cached: CachedProfile = JSON.parse(content);
      if (nowSecs() - cached.fetched_at < PROFILE_CACHE_TTL) return cached.domain;
    } catch {
      // Cache miss
    }

    const token = readAccessToken();
    if (!token) return null;

    const profile = await fetchWithToken<{ account?: { email?: string } }>(
      token,
      "https://api.anthropic.com/api/oauth/profile",
    );
    const email = profile?.account?.email;
    if (!email) return null;

    const domain = email.split("@")[1] ?? email;

    // Write cache — 0o600 per credential-pool spec (profile-cache.json holds email
    // domain; low-sensitivity but spec-gated for consistency with usage-cache).
    try {
      const cached: CachedProfile = { fetched_at: nowSecs(), domain };
      writeFileSync(cachePath, JSON.stringify(cached), { mode: 0o600 });
    } catch {
      // Non-fatal
    }

    return domain;
  } catch {
    return null;
  }
}

// ── Gauge rendering ──────────────────────────────────────────────────────────

function renderGauge(label: string, pct: number, suffix: string): string {
  const color = pct <= 20 ? CTX_LOW : pct <= 40 ? CTX_MED : CTX_HIGH;
  const filled = Math.floor((pct * 7) / 100);
  const empty = 7 - filled;
  const bar = "═".repeat(filled) + "─".repeat(empty);
  return `${DIM}${label}${RESET} ${color}${bar} ${suffix}${RESET}`;
}

function renderContext(remainingPct: number): string {
  const pct = Math.round(remainingPct);
  return renderGauge("CTX", pct, `${pct}%`);
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

interface RenderDeps {
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

  // CC model name + output_style (between project info and git)
  if (ccInput.model?.display_name) {
    parts.push(`${DIM}${shortenModel(ccInput.model.display_name)}${RESET}`);
  }
  const outputStyle = ccInput.output_style;
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

  // Active spec (from nexus-agent session — spec field may be absent)
  const spec = (session as Record<string, unknown> | undefined)?.spec;
  if (typeof spec === "string" && spec.length > 0) {
    parts.push(`⚡ ${SPEC}${spec}${RESET}`);
  }

  // Context window — CC sends used_percentage; we display remaining
  const usedPct = ccInput.context_window?.used_percentage;
  if (usedPct != null) {
    const remaining = 100 - usedPct;
    parts.push(renderContext(remaining));
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
      parts.push(
        renderUsageGauge("7D", usage.seven_day.utilization, usage.seven_day.resets_at, 7 * 86400),
      );
    }
  }

  return parts.join("  ");
}

export type { CcInput, GitInfo, StatuslineResponse, UsageResponse };

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

  // Parallel fetches: agent statusline, API usage, account domain
  const [nexusData, usage, accountDomain] = await Promise.all([
    fetchStatusline(agentUrl),
    getApiUsage(),
    getAccountDomain(),
  ]);

  const out = renderStatusline(ccInput, {
    git,
    nexusData,
    usage,
    accountDomain,
    projectDir,
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
