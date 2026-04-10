#!/usr/bin/env bun
/**
 * nexus-status — Claude Code statusline extension (Bun replacement).
 *
 * Runs on every prompt render. Outputs a compact one-line status to stdout.
 * On any error, outputs empty string — statusline must never crash.
 *
 * Reads CC context from stdin (JSON piped by Claude Code):
 *   { context_window: { remaining_percentage: number }, model: { display_name: string } }
 *
 * Environment:
 *   NEXUS_ATTACH_SECRET — Required auth header for agent API
 *   CLAUDE_PROJECT_DIR  — Current project directory (fallback: cwd)
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
  context_window?: { remaining_percentage?: number };
  model?: { display_name: string };
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

const ATTACH_SECRET = process.env.NEXUS_ATTACH_SECRET ?? "";
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
      headers: { "x-nexus-secret": ATTACH_SECRET },
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

    // Write cache
    try {
      const cached: CachedUsage = { fetched_at: nowSecs(), data: fresh };
      writeFileSync(cachePath, JSON.stringify(cached));
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

    // Write cache
    try {
      const cached: CachedProfile = { fetched_at: nowSecs(), domain };
      writeFileSync(cachePath, JSON.stringify(cached));
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
  const bar = "\u2550".repeat(filled) + "\u2500".repeat(empty);
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
    arrow = "\u2191";
    color = CTX_LOW;
  } else if (projected >= 75) {
    arrow = "\u2197";
    color = CTX_MED;
  } else {
    arrow = "\u2192";
    color = CTX_HIGH;
  }
  return `${color}${arrow}${Math.round(projected)}%${RESET}`;
}

function renderUsageGauge(
  label: string,
  utilization: number,
  resetsAt: string | undefined,
  windowSecs: number,
): string {
  const now = nowSecs();
  const remainingSecs = resetsAt
    ? Math.max((parseTimestamp(resetsAt) ?? now) - now, 0)
    : 0;

  const remainingPct = Math.max(100 - utilization, 0);
  const projected = projectUtilization(utilization, windowSecs, remainingSecs);
  const momentum = momentumIndicator(projected);

  // Countdown string
  let countdown: string;
  if (remainingSecs === 0) {
    countdown = "\u21bbnow";
  } else if (remainingSecs >= 86400 * 2) {
    countdown = `\u21bb${Math.floor(remainingSecs / 86400)}d`;
  } else {
    const h = Math.floor(remainingSecs / 3600);
    const m = Math.floor((remainingSecs % 3600) / 60);
    countdown = `\u21bb${h}:${String(m).padStart(2, "0")}h`;
  }

  const suffix = momentum
    ? `${Math.round(utilization)}% ${momentum} ${countdown}`
    : `${Math.round(utilization)}% ${countdown}`;

  // Color gauge by projected risk
  let gaugePct = remainingPct;
  if (projected >= 95) gaugePct = Math.min(gaugePct, 20);
  else if (projected >= 75) gaugePct = Math.min(gaugePct, 40);

  return renderGauge(label, gaugePct, suffix);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ccInput = readStdinInput();

  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const projectCode = deriveProjectCode(projectDir);
  const git = getGitStatus(projectDir);
  const agentUrl = getLocalAgentUrl();

  // CC model name (from stdin)
  const ccModel = ccInput.model
    ? shortenModel(ccInput.model.display_name)
    : null;

  // Parallel fetches: agent statusline, API usage, account domain
  const [nexusData, usage, accountDomain] = await Promise.all([
    fetchStatusline(agentUrl),
    getApiUsage(),
    getAccountDomain(),
  ]);

  const session = nexusData?.sessions.find(
    (s) => s.project === projectCode,
  );

  // ── Build parts ──────────────────────────────────────────────────────────
  const parts: string[] = [];

  // Session count indicator
  const sessionCount = nexusData?.sessions.length ?? 0;
  if (sessionCount > 1) {
    parts.push(`${DIM}\u25C9${RESET} ${sessionCount}`);
  } else if (sessionCount === 1) {
    parts.push(`${DIM}\u25C9${RESET}`);
  } else {
    parts.push(`${DIM}\u25CC${RESET}`);
  }

  // Account domain
  if (accountDomain) {
    const short = accountDomain.split(".")[0] ?? accountDomain;
    parts.push(`${DIM}@${short}${RESET}`);
  }

  // Project code
  parts.push(`${PROJ}${projectCode}${RESET}`);

  // Git branch
  if (git) {
    let branchPart = git.dirty
      ? `${GIT_DIRTY}${git.branch}*${RESET}`
      : `${GIT}${git.branch}${RESET}`;
    if (git.ahead > 0) {
      branchPart += `  ${DIM}\u2191${git.ahead}${RESET}`;
    }
    parts.push(branchPart);
  }

  // Active spec (from nexus-agent session — spec field may be absent)
  const spec = (session as Record<string, unknown> | undefined)?.spec;
  if (typeof spec === "string" && spec.length > 0) {
    parts.push(`\u26A1 ${SPEC}${spec}${RESET}`);
  }

  // Context window (from CC stdin)
  const remaining = ccInput.context_window?.remaining_percentage;
  if (remaining != null) {
    parts.push(renderContext(remaining));
  }

  // Session (5hr) and Weekly (7d) usage
  if (usage) {
    if (usage.five_hour) {
      parts.push(
        renderUsageGauge("5H", usage.five_hour.utilization, usage.five_hour.resets_at, 5 * 3600),
      );
    }
    if (usage.seven_day) {
      parts.push(
        renderUsageGauge("7D", usage.seven_day.utilization, usage.seven_day.resets_at, 7 * 86400),
      );
    }
  }

  process.stdout.write(parts.join("  "));
}

main().catch(() => {
  // Silent — statusline must never crash
});
