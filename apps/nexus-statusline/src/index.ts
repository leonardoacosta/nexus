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
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { nowSecs } from "./cache-io";
import type {
  CcInput,
  StatuslineSession,
  StatuslineResponse,
  GitInfo,
  UsagePeriod,
  UsageResponse,
  CachedUsage,
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

// ── Types ────────────────────────────────────────────────────────────────────

interface CachedProfile {
  fetched_at: number;
  domain: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 2_000;
const PROFILE_CACHE_TTL = 3600; // 1 hour (seconds)

// Suspicious-zero context guard
const CTX_FRESH_WINDOW_SECS = 600; // 10-min last-good snapshot freshness window
const CTX_WRITE_THROTTLE_MS = 3_000; // skip a snapshot rewrite when the file is <3s old

// tokens/sec via transcript byte-growth
const SPEED_WINDOW_MS = 2_000; // samples older than this are stale → reset
const MIN_DELTA_MS = 500; // samples younger than this are too soon → keep, no estimate

// Polled-usage cache: older than this → treat as absent (agent down/undeployed).
// 30 min = poller cadence + backoff headroom; pre-consolidation intent was 300s.
const USAGE_CACHE_MAX_AGE_SECS = 30 * 60;

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

// ── Model/effort token ────────────────────────────────────────────────────────

/** Family letter keyed by substring found in model.id / display_name. */
const MODEL_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ["fable", "F"],
  ["opus", "O"],
  ["sonnet", "S"],
  ["haiku", "H"],
];

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
 * Family letter alone (from `model.id`, `display_name` fallback; unknown
 * family → uppercased `display_name` initial). No model → null. Shared by
 * `modelEffortToken` (row-one token) and the session-context harvest (which
 * needs the letter without the effort suffix).
 */
export function modelFamilyLetter(
  model?: { id?: string; display_name?: string },
): string | null {
  if (!model) return null;
  const id = model.id ?? "";
  const dn = model.display_name ?? "";
  if (!id && !dn) return null;

  const hay = `${id} ${dn}`.toLowerCase();
  for (const [fam, l] of MODEL_FAMILIES) {
    if (hay.includes(fam)) return l;
  }
  const initial = dn.trim().charAt(0) || id.trim().charAt(0);
  return initial ? initial.toUpperCase() : null;
}

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

// ── B&B project gate (radar content) ─────────────────────────────────────────

/** B&B fleet project codes — allowlist fallback when no project.toml `org` key. */
const BB_ALLOWLIST: ReadonlySet<string> = new Set([
  "ws", "fb", "dc", "se", "tb", "sc", "ba", "bo", "es", "ew", "ic", "lu", "pp",
]);

/**
 * Is this project part of the B&B fleet? `<projectDir>/.claude/project.toml`
 * `[project].org` is authoritative when present (`"bb"` = B&B); otherwise fall
 * back to the hardcoded allowlist matched against the derived project code.
 * Same no-TOML-dep regex approach as `getLocalAgentUrl`. All reads wrapped —
 * never throws; unreadable/absent toml + unlisted code → non-B&B (radar hidden
 * by default; a false-hide is low-cost, a false-show on a personal repo is not).
 */
export function isBbProject(projectDir: string): boolean {
  try {
    const tomlPath = join(projectDir, ".claude/project.toml");
    const content = readFileSync(tomlPath, "utf-8");
    const orgMatch = content.match(/^\s*org\s*=\s*["']([^"']+)["']/m);
    if (orgMatch) return orgMatch[1] === "bb";
  } catch {
    // No toml / unreadable — fall through to allowlist
  }
  try {
    return BB_ALLOWLIST.has(deriveProjectCode(projectDir));
  } catch {
    return false;
  }
}

/**
 * Strip the exact `radar:stale` token from each comma-CSV row of a pulse line,
 * dropping any row that becomes empty. Rows without the token pass through.
 */
export function stripRadarStale(line: string): string {
  return line
    .split("\n")
    .map((row) => {
      if (!row.includes("radar:stale")) return row;
      return row
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t !== "radar:stale")
        .join(",");
    })
    .filter((row) => row.length > 0)
    .join("\n");
}

/**
 * Apply the B&B gate to a cached pulse line: B&B renders verbatim; non-B&B has
 * the `radar:stale` token stripped (line dropped entirely if it becomes empty).
 */
export function gatePulseLine(line: string | null, isBb: boolean): string | null {
  if (line == null) return null;
  if (isBb) return line;
  const stripped = stripRadarStale(line);
  return stripped.length > 0 ? stripped : null;
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

/**
 * Apply the staleness bound to a parsed usage cache. Exported for tests.
 * Missing/non-numeric `fetched_at` → treat as stale (null). The writer
 * (apps/agent statusline-usage-file.ts) always writes unix-seconds
 * `fetched_at`, so a well-formed cache only goes null by aging out.
 */
export function polledUsageFromCache(
  cached: CachedUsage | null | undefined,
  atSecs: number,
): UsageResponse | null {
  if (!cached || typeof cached.fetched_at !== "number") return null;
  if (atSecs - cached.fetched_at > USAGE_CACHE_MAX_AGE_SECS) return null;
  return cached.data ?? null;
}

/**
 * Read the active credential's 5H/7D usage from the shared cache file that
 * nexus-agent's poller writes (statusline-usage-file.ts). Pure file read +
 * parse — NO Anthropic API call, NO credential read. The poller is now the sole
 * caller of `/api/oauth/usage`, which eliminates the uncoordinated dual-caller
 * 429 (proposal §Why). Matches the existing `CachedUsage` shape
 * (`{ fetched_at, data }`) so the writer and reader agree on one schema.
 * Fail-soft: a missing / unreadable / unparseable cache → null (usage segment
 * omitted, never a crash). Caches older than `USAGE_CACHE_MAX_AGE_SECS` are
 * treated as absent — a dead or undeployed poller degrades to an omitted
 * usage segment, never frozen bars. Returns a Promise to satisfy
 * `resolveUsage`'s injectable `fetchApiUsage` signature.
 */
async function getPolledUsage(): Promise<UsageResponse | null> {
  try {
    const content = readFileSync(usageCachePath(), "utf-8");
    const cached: CachedUsage = JSON.parse(content);
    return polledUsageFromCache(cached, nowSecs());
  } catch {
    return null;
  }
}

/**
 * Build a `UsageResponse` from the CC stdin `rate_limits` block when BOTH the
 * `five_hour` and `seven_day` windows carry a `used_percentage` (CC v2.1.6+).
 * Maps `used_percentage → utilization`. Reset info is NOT copied onto the
 * `UsagePeriod` here — it flows through the existing `ccInput.rate_limits.*`
 * `resets_at` precedence in `renderStatusline`/`renderUsageGauge` (CC unix-secs
 * wins over any API ISO string). Returns null when either window lacks
 * `used_percentage`, signalling the caller to fall back to the OAuth API.
 */
export function buildStdinUsage(
  rateLimits: CcInput["rate_limits"],
): UsageResponse | null {
  const fh = rateLimits?.five_hour?.used_percentage;
  const sd = rateLimits?.seven_day?.used_percentage;
  if (fh == null || sd == null) return null;
  return {
    five_hour: { utilization: fh },
    seven_day: { utilization: sd },
  };
}

/**
 * Prefer stdin usage over the polled cache. When `buildStdinUsage` yields a
 * value, return it and skip `getPolledUsage()` entirely. Otherwise fall back to
 * the injected fetcher (default `getPolledUsage`, a pure file read of the
 * poller-written cache — no network, no credential access). `fetchApiUsage` is
 * injectable so the fallback gate is testable without a filesystem dependency.
 */
export async function resolveUsage(
  rateLimits: CcInput["rate_limits"],
  fetchApiUsage: () => Promise<UsageResponse | null> = getPolledUsage,
): Promise<UsageResponse | null> {
  const stdin = buildStdinUsage(rateLimits);
  if (stdin != null) return stdin;
  return fetchApiUsage();
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

// ── Suspicious-zero context guard ────────────────────────────────────────────

/** Per-session last-good context snapshot. `saved_at` is unix seconds. */
interface CtxSnapshot {
  used_percentage: number;
  context_window_size?: number;
  saved_at: number;
}

/** Context value resolved by the guard for rendering (null = omit segment). */
interface ResolvedContext {
  usedPct: number;
  contextWindowSize?: number;
}

/** Injectable seams for the context-guard resolver (deterministic in tests). */
interface CtxResolverDeps {
  readSnapshot?: (path: string) => CtxSnapshot | null;
  writeSnapshot?: (path: string, snap: CtxSnapshot) => void;
  statMtimeMs?: (path: string) => number | null;
  now?: () => number; // unix seconds
  nowMs?: () => number; // milliseconds (write-throttle)
}

function ctxSnapshotPath(sessionId: string): string {
  return join(
    homedir(),
    `.claude/scripts/state/statusline-ctx.${sessionId}.json`,
  );
}

function defaultReadSnapshot(path: string): CtxSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw?.used_percentage !== "number") return null;
    if (typeof raw?.saved_at !== "number") return null;
    return raw as CtxSnapshot;
  } catch {
    return null;
  }
}

function defaultWriteSnapshot(path: string, snap: CtxSnapshot): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // fail-soft — a snapshot write never crashes the render
  }
}

function defaultStatMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Resolve the context value to render, guarding against CC's spurious
 * `used_percentage: 0` frame (design.md §1). On a populated frame (`> 0`) the
 * per-session snapshot is refreshed (3s write-throttle) and the live value
 * returned. On a `0`/absent frame the fresh snapshot (≤10 min old) is restored,
 * else the segment is omitted (returns null) — it MUST NOT render `CTX 100%`.
 * Missing `session_id` → no snapshot key → treated as fresh (omit on zero). All
 * fs access is fail-soft.
 */
export function resolveContext(
  ccInput: CcInput,
  deps: CtxResolverDeps = {},
): ResolvedContext | null {
  const readSnapshot = deps.readSnapshot ?? defaultReadSnapshot;
  const writeSnapshot = deps.writeSnapshot ?? defaultWriteSnapshot;
  const statMtimeMs = deps.statMtimeMs ?? defaultStatMtimeMs;
  const now = deps.now ?? nowSecs;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const usedPct = ccInput.context_window?.used_percentage;
  const size = ccInput.context_window?.context_window_size;
  const sessionId = ccInput.session_id;

  // Populated frame: render the live value + refresh the snapshot (throttled).
  if (usedPct != null && usedPct > 0) {
    if (sessionId) {
      const path = ctxSnapshotPath(sessionId);
      const mtime = statMtimeMs(path);
      const throttled = mtime != null && nowMs() - mtime < CTX_WRITE_THROTTLE_MS;
      if (!throttled) {
        writeSnapshot(path, {
          used_percentage: usedPct,
          context_window_size: size,
          saved_at: now(),
        });
      }
    }
    return { usedPct, contextWindowSize: size };
  }

  // Suspicious zero / absent: restore a fresh snapshot, else omit.
  if (!sessionId) return null;
  const snap = readSnapshot(ctxSnapshotPath(sessionId));
  if (
    snap &&
    snap.used_percentage > 0 &&
    now() - snap.saved_at <= CTX_FRESH_WINDOW_SECS
  ) {
    return { usedPct: snap.used_percentage, contextWindowSize: snap.context_window_size };
  }
  return null;
}

// ── Per-pane session-context harvest (cc-tmux-session-usage-bars) ────────────

export function sessionContextPath(pane: string): string {
  return join(
    homedir(),
    `.claude/scripts/state/session-context.${pane}.json`,
  );
}

/**
 * Harvest the two fields cc-tmux's session-bar row needs —
 * `context_window.used_percentage` and the model family letter (the same
 * letter `modelEffortToken` computes for row one, via `modelFamilyLetter`) —
 * into a per-pane cache file (proposal §What Changes 2; the sole surviving
 * sliver of the original full-parity harvest). Keyed by `$TMUX_PANE` (tmux's
 * `#{pane_id}`, e.g. `%3`) so cc-tmux resolves the same file for the same pane.
 *
 * Gated on `$TMUX_PANE` — a no-op outside tmux. Atomic write (`.tmp` + rename),
 * fail-soft: never throws, never blocks the render. A null/undefined `usedPct`
 * (the suspicious-zero guard omitted the segment this frame) is a no-op, leaving
 * any prior good value in place rather than clobbering it with a zero. On frames
 * that pass the `usedPct` gate, the model letter is included whenever available
 * and omitted (no `model` key) when the frame carries no model; a null-`usedPct`
 * frame writes nothing at all, so the prior snapshot's letter is preserved along
 * with its pct. `git` (branch/dirty/ahead, already computed per-render at the
 * call site for the left-status segment) rides along when `getGitStatus` resolved a value;
 * `null`/`undefined` omits all three keys, so an older cc-tmux (or a fixture
 * with no git data) sees exactly the pre-existing shape — the reader treats
 * absent keys as "no data" (plan 004 cross-repo contract).
 */
export function writeSessionContext(
  usedPct: number | null | undefined,
  modelLetter: string | null | undefined,
  git?: GitInfo | null,
): void {
  try {
    const pane = process.env.TMUX_PANE;
    if (!pane || usedPct == null) return;
    const path = sessionContextPath(pane);
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        context_used_pct: usedPct,
        ...(modelLetter ? { model: modelLetter } : {}),
        ...(git ? { branch: git.branch, dirty: git.dirty, ahead: git.ahead } : {}),
        ts: nowSecs(),
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, path);
  } catch {
    // fail-soft — a harvest write never crashes the render
  }
}

/** Orphaned session-context files older than this are pruned by the GC. */
const SESSION_CONTEXT_TTL_SECS = 6 * 60 * 60;

/** Injectable seams for `gcSessionContext` (deterministic in tests). */
interface GcDeps {
  dir?: string; // state dir override (tests use a tmpdir)
  random?: () => number; // 1-in-100 gate source
}

/** Per-session state-file prefixes the GC owns. All are session/pane-keyed
 * and never reused by CC, so nothing else ever unlinks them. */
const GC_STATE_PREFIXES = [
  "session-context.",
  "statusline-ctx.",
  "statusline-speed.",
] as const;

/**
 * Opportunistic GC for orphaned per-session state files — `session-context.
 * <pane>.json`, `statusline-ctx.<sessionId>.json`, and `statusline-speed.
 * <sessionId>.json`. A closed tmux pane / ended session leaves its cache
 * file(s) behind forever — neither tmux pane ids (`%N`) nor CC session ids
 * are predictably reused, so nothing else ever unlinks them. Gated behind a
 * 1-in-100 probability (mirroring `skill-list-dedup.sh`'s marker prune) so
 * the directory scan runs on ~1% of renders and is skipped entirely — no
 * scan, no stat — on the other 99%. Fail-soft: never throws, never blocks
 * the render.
 */
export function gcSessionContext(deps: GcDeps = {}): void {
  const random = deps.random ?? Math.random;
  if (Math.floor(random() * 100) !== 0) return; // 1-in-100: skip the scan
  try {
    const dir = deps.dir ?? join(homedir(), ".claude/scripts/state");
    const cutoff = nowSecs() - SESSION_CONTEXT_TTL_SECS;
    for (const name of readdirSync(dir)) {
      if (
        !GC_STATE_PREFIXES.some((p) => name.startsWith(p)) ||
        !name.endsWith(".json")
      ) {
        continue;
      }
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs / 1000 < cutoff) unlinkSync(full);
      } catch {
        // a file vanishing mid-scan (concurrent render) is fine — skip it
      }
    }
  } catch {
    // fail-soft — GC never crashes the render
  }
}

// ── tokens/sec via transcript byte-growth (stat-only) ────────────────────────

/** Per-session speed sample. `timestamp` is milliseconds. */
interface SpeedCache {
  fileSize: number;
  timestamp: number;
}

/** Injectable seams for `getSpeed` (deterministic in tests). */
interface SpeedDeps {
  statSize?: (path: string) => number | null;
  readCache?: (path: string) => SpeedCache | null;
  writeCache?: (path: string, cache: SpeedCache) => void;
  nowMs?: () => number;
}

function speedCachePath(sessionId: string): string {
  return join(
    homedir(),
    `.claude/scripts/state/statusline-speed.${sessionId}.json`,
  );
}

function defaultStatSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function defaultReadSpeedCache(path: string): SpeedCache | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw?.fileSize !== "number" || typeof raw?.timestamp !== "number") {
      return null;
    }
    return raw as SpeedCache;
  } catch {
    return null;
  }
}

function defaultWriteSpeedCache(path: string, cache: SpeedCache): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // fail-soft
  }
}

/**
 * Heuristic tokens/sec from transcript byte-growth between renders (design.md
 * §3). `statSync(transcriptPath).size` ONLY — the transcript is never read or
 * parsed. Per-session cache holds the last `{ fileSize, timestamp }`. Guards:
 * shrink → reset, null; `deltaMs > SPEED_WINDOW_MS` → stale, reset, null;
 * `deltaMs < MIN_DELTA_MS` → too soon, keep cache, null; `deltaBytes <= 0` →
 * null. Estimate: `(deltaBytes / 4) / (deltaMs / 1000)`. Fail-soft throughout.
 */
export function getSpeed(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  deps: SpeedDeps = {},
): number | null {
  if (!transcriptPath || !sessionId) return null;
  const statSize = deps.statSize ?? defaultStatSize;
  const readCache = deps.readCache ?? defaultReadSpeedCache;
  const writeCache = deps.writeCache ?? defaultWriteSpeedCache;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const size = statSize(transcriptPath);
  if (size == null) return null;
  const now = nowMs();
  const path = speedCachePath(sessionId);
  const prev = readCache(path);

  // First sample for this session — establish a baseline, no estimate yet.
  if (prev == null) {
    writeCache(path, { fileSize: size, timestamp: now });
    return null;
  }

  const deltaMs = now - prev.timestamp;
  const deltaBytes = size - prev.fileSize;

  // File/counter shrink → reset baseline.
  if (deltaBytes < 0) {
    writeCache(path, { fileSize: size, timestamp: now });
    return null;
  }
  // Stale interval → reset baseline.
  if (deltaMs > SPEED_WINDOW_MS) {
    writeCache(path, { fileSize: size, timestamp: now });
    return null;
  }
  // Too soon → keep the existing baseline so a later in-window render can measure.
  if (deltaMs < MIN_DELTA_MS) {
    return null;
  }
  // No growth → no estimate (keep baseline; it will age out to stale).
  if (deltaBytes <= 0) {
    return null;
  }

  const estimatedTokens = deltaBytes / 4;
  const speed = estimatedTokens / (deltaMs / 1000);
  writeCache(path, { fileSize: size, timestamp: now });
  return speed;
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

export type { CcInput, GitInfo, StatuslineResponse, UsageResponse } from "./types";

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
