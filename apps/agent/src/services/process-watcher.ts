/**
 * Process watcher — keeps the `sessions` table in sync with the set of live
 * `claude` processes on this machine.
 *
 * On a 30-second interval (configurable) the watcher:
 *   1. Runs `pgrep -af claude` and parses the (pid, cmd) pairs.
 *   2. Filters down to genuine `claude` binaries — helper procs (mcp, zsh
 *      wrappers, etc.) are excluded.
 *   3. Runs `tmux list-panes -a` and builds a Map<claudePid, PaneInfo>
 *      by walking pane_pid descendants for each pane whose
 *      pane_current_command is `claude`. The pane carries the authoritative
 *      cwd (`pane_current_path`) and canonical tmuxTarget
 *      (`<session>:<window>.<pane>`).
 *   4. Loads all open session rows (`status = 'active' AND ended_at IS
 *      NULL`) that the watcher already tagged with a PID. For each one
 *      whose PID has disappeared, sets `endedAt = NOW()`, `status =
 *      "ended"` and emits a `RemoteSessionEnded` lifecycle event.
 *   5. For every live PID that has no matching row, INSERTS a new row. If
 *      the PID matched a PaneInfo, cwd + tmuxTarget come from tmux and the
 *      git-project resolver is called inline; otherwise cwd is empty and
 *      enrichment is deferred to a later poll once a hook supplies cwd.
 *
 * Why tmux instead of /proc readlinks: user-instance systemd cannot grant
 * CAP_SYS_PTRACE under Yama=1. The earlier `session-attach-and-cwd-cap`
 * spec wired `AmbientCapabilities=CAP_SYS_PTRACE` into the unit file, but
 * user-instance systemd holds CapEff=0x800000000 (cap_audit_write only) —
 * it cannot delegate a capability it does not itself hold.
 * ptrace_may_access() rejects readlink of /proc/<other-pid>/cwd with EACCES
 * even with the ambient bit set, because the granting authority (user
 * systemd) never had the cap. /proc/PID/environ has the same restriction
 * (file mode r-------- enforces ptrace_may_access). See nx-9jz0v.
 *
 * tmux sidesteps the kernel entirely — it runs as the same user, owns its
 * own state, and exposes pane data via plain stdout. Every managed CC
 * session lives in a tmux pane, so this is the authoritative source for
 * cwd + tmuxTarget the moment the watcher fires (before any CC hook).
 *
 * Legacy rows whose `pid` is null are NEVER closed by this watcher — those
 * predate the tracking work and may have been created by hooks. The
 * one-shot cleanup migration (task 1.1) already retired the dead ones.
 *
 * See: fix-agent-cc-session-tracking § Scenario "Process watcher
 * reconciles dead PIDs" / "detects new claude processes". Tmux-source
 * change tracked as nx-ds6rq.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@nexus/db";
import { sessions, eq, processWatcherState } from "@nexus/db";
import { and, isNull, isNotNull, gt, lt, sql } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { execText } from "../utils/exec";
import {
  upsertSession,
  touchHeartbeatByPids,
  updateSessionGitOrigin,
} from "../db/sessions";
import { lifecycleBus } from "./lifecycle-bus";
import { resolveProject, resolverCacheStats } from "./git-project-resolver";
import {
  recordTickDurationMs,
  incPidsOpened,
  incPidsClosed,
  setStaleRowsGauge,
} from "./process-watcher-metrics";

const log = createLogger("agent:process-watcher");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Git branch resolver — session-enrichment
// ---------------------------------------------------------------------------
//
// Replaces the hardcoded `branch: null` on new-session creation with a
// fail-soft `git rev-parse --abbrev-ref HEAD` in the session's cwd. Memoised by
// cwd for 30s, mirroring `git-project-resolver`'s cache: the watcher's 30s poll
// cadence MUST NOT re-shell `git` on every tick. Negative results (non-git dir,
// timeout, missing binary) are cached too so a flapping/foreign dir doesn't peg
// CPU. NEVER throws — every failure mode returns `null` (no user-facing error).

const BRANCH_CACHE_TTL_MS = 30_000;
const BRANCH_RESOLVE_TIMEOUT_MS = 2_000;

interface BranchCacheEntry {
  value: string | null;
  expiresAt: number;
}

const branchCache = new Map<string, BranchCacheEntry>();

/** Clear cached branch lookups. Tests call this to isolate scenarios. */
function clearBranchCache(): void {
  branchCache.clear();
}

/**
 * Resolve the current git branch for `cwd` via `git rev-parse --abbrev-ref HEAD`.
 *
 * Returns the branch name on success, or `null` for a non-git directory,
 * empty/missing cwd, a detached HEAD (`HEAD`), a non-zero exit, a timeout, or a
 * missing git binary. Memoised per-cwd for 30s (positive AND negative results).
 * Never throws — fail-soft per the session-enrichment spec.
 */
async function resolveBranch(
  cwd: string | null | undefined,
): Promise<string | null> {
  if (!cwd) return null;

  const now = Date.now();
  const cached = branchCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(
      ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, BRANCH_RESOLVE_TIMEOUT_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode === 0) {
      const out = stdout.trim();
      // `HEAD` means detached — treat as "no branch" (null), matching the
      // git-project metadata resolver's detached-HEAD handling.
      value = out.length > 0 && out !== "HEAD" ? out : null;
    }
  } catch (err) {
    log.debug(
      { err, cwd },
      "process-watcher: branch resolution failed (non-git or git missing) — null",
    );
    value = null;
  } finally {
    if (timer) clearTimeout(timer);
  }

  branchCache.set(cwd, { value, expiresAt: now + BRANCH_CACHE_TTL_MS });
  return value;
}

/** Match a pgrep line whose command is the real `claude` binary. */
function isClaudeCommand(cmd: string): boolean {
  // Reject helper procs whose command happens to contain the substring
  // "claude" (mcp, zsh wrappers, npm scripts, etc.). The actual binary line
  // either starts with `claude ` (or just `claude`) or is invoked by full
  // path ending in `/claude`.
  const trimmed = cmd.trim();
  if (trimmed === "claude") return true;
  if (trimmed.startsWith("claude ")) return true;
  // Path-prefixed invocations: `/usr/local/bin/claude --foo` etc.
  if (/(^|\s)\S*\/claude(\s|$)/.test(trimmed)) return true;
  return false;
}

interface LiveProcess {
  pid: number;
  cmd: string;
}

/**
 * Run `pgrep -af claude` and return the parsed live `claude` processes.
 * `-a` formats each line as `PID COMMAND…`. Exit code 1 from pgrep means
 * "no matches" — translated to an empty list, not an error.
 *
 * Tri-state return: `LiveProcess[]` = scan succeeded (possibly empty),
 * `null` = the scan itself FAILED (timeout, exec crash, non-1 exit). The
 * caller MUST branch on null and leave managed rows untouched — a failed
 * scan is NOT evidence that every session died. Collapsing failure into
 * `[]` closed every open row on a single flaky pgrep tick (see plan 001).
 */
async function listClaudeProcesses(): Promise<LiveProcess[] | null> {
  let stdout: string;
  try {
    stdout = await execText("pgrep", ["-af", "claude"]);
  } catch (err) {
    // pgrep exits 1 when nothing matches; that's not an error.
    const exitCode =
      err instanceof Error && "exitCode" in err
        ? (err as { exitCode?: number }).exitCode
        : undefined;
    if (exitCode === 1) return [];
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "pgrep failed; skipping row reconciliation this tick (managed rows left untouched)",
    );
    return null;
  }

  const procs: LiveProcess[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const pidStr = trimmed.slice(0, spaceIdx);
    const cmd = trimmed.slice(spaceIdx + 1);
    const pid = parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!isClaudeCommand(cmd)) continue;
    procs.push({ pid, cmd });
  }
  return procs;
}

// ---------------------------------------------------------------------------
// tmux pane scan — authoritative source for cwd + tmuxTarget
// ---------------------------------------------------------------------------

/**
 * Cwd + tmuxTarget for a single claude process, derived from the tmux pane
 * that owns the pid's ancestry. Surfaces enough to populate a new
 * `sessions` row without any /proc reads.
 */
export interface PaneInfo {
  /** PID of the actual `claude` binary (a descendant of paneShell). */
  claudePid: number;
  /** Pane's `pane_current_path` — authoritative cwd. */
  cwd: string;
  /** Canonical `<session>:<window>.<pane>` tmux address. */
  tmuxTarget: string;
  /** Pane shell pid (`pane_pid`) — root of the descendant walk. */
  paneShell: number;
}

interface RawPane {
  paneShell: number;
  cwd: string;
  tmuxTarget: string;
  paneCmd: string;
}

/**
 * Run `tmux list-panes -a` with a stable field-separated format and return
 * raw pane rows. Returns an empty list if tmux is not running, the server
 * is unreachable, or the call errors — never throws.
 *
 * Format chosen so we never have to deal with quoting in the format string:
 *   pane_pid|pane_current_path|session_name|window_index|pane_index|pane_current_command
 */
async function listTmuxPanes(): Promise<RawPane[]> {
  const TMUX_FORMAT =
    "#{pane_pid}|#{pane_current_path}|#{session_name}|#{window_index}|#{pane_index}|#{pane_current_command}";
  let stdout: string;
  try {
    // The format string contains `#{…}` placeholders which trip the
    // safeSpawn shell-metacharacter guard. The string is a hard-coded
    // constant in this file with no user-controlled input — safe to opt
    // out of arg validation here. tmux is the bin allowlisted in
    // ALLOWED_BINARIES; trustArgs only skips the arg-content check, not
    // the binary allowlist.
    stdout = await execText("tmux", ["list-panes", "-a", "-F", TMUX_FORMAT], {
      trustArgs: true,
    });
  } catch (err) {
    // No tmux server, or some other failure. Fail-soft — fall back to
    // PID-only detection (cwd empty, tmuxTarget null).
    log.info(
      { error: err instanceof Error ? err.message : String(err) },
      "tmux list-panes failed; proceeding with PID-only detection",
    );
    return [];
  }

  const rows: RawPane[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split on `|` — none of the source fields legitimately contain `|`
    // (paths/commands on disk that contain `|` are exotic enough that we
    // accept the rare false negative rather than re-parse with a less
    // ambiguous separator).
    const parts = trimmed.split("|");
    if (parts.length < 6) continue;
    const pid = parseInt(parts[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const cwd = parts[1] ?? "";
    const session = parts[2] ?? "";
    const window = parts[3] ?? "";
    const pane = parts[4] ?? "";
    const paneCmd = (parts[5] ?? "").trim();
    if (!session || !window || !pane) continue;
    rows.push({
      paneShell: pid,
      cwd,
      tmuxTarget: `${session}:${window}.${pane}`,
      paneCmd,
    });
  }
  return rows;
}

/**
 * For each pane whose `pane_current_command` is `claude`, walk descendants
 * of `pane_pid` until we find the actual `claude` binary's pid. Returns a
 * `Map<claudePid, PaneInfo>` keyed by the real claude pid so the watcher
 * can join against pgrep output.
 *
 * Why a walk: tmux reports `pane_current_command` from the active leaf of
 * the pane's process group, but `pane_pid` is the pane's root shell. The
 * actual `claude` invocation is normally one or two `fork+exec` hops down
 * (shell → claude, or shell → wrapper → claude). We BFS the process tree
 * via `pgrep -P <pid>` (allowlisted, no shell, fast) and stop at the first
 * descendant whose pid is also present in `claudePidSet` (the live set
 * reported by `pgrep -af claude` upstream — guaranteed to be a real
 * `claude` binary, not a helper proc).
 *
 * Depth/width are bounded to keep a runaway/fan-out scan from blocking the
 * watcher tick.
 */
async function tmuxScan(claudePidSet: Set<number>): Promise<Map<number, PaneInfo>> {
  const panes = await listTmuxPanes();
  const out = new Map<number, PaneInfo>();
  if (panes.length === 0) return out;

  let scannedPanes = 0;
  let matchedPanes = 0;

  for (const pane of panes) {
    // Only walk panes whose foreground command actually looks like
    // claude — otherwise the descendant search is wasted work.
    if (!isPaneClaudeCommand(pane.paneCmd)) continue;
    scannedPanes += 1;

    // BFS for a descendant pid that's in the live claude set.
    const claudePid = await findClaudeDescendant(pane.paneShell, claudePidSet);
    if (claudePid === null) continue;
    matchedPanes += 1;

    // First pane wins per claudePid — if a claude process is somehow
    // visible under two panes (shouldn't happen in practice), pin to
    // whatever we saw first to keep the mapping deterministic.
    if (out.has(claudePid)) continue;
    out.set(claudePid, {
      claudePid,
      cwd: pane.cwd,
      tmuxTarget: pane.tmuxTarget,
      paneShell: pane.paneShell,
    });
  }

  log.info(
    { panes: panes.length, scanned: scannedPanes, matched: matchedPanes },
    "tmux pane scan complete",
  );
  return out;
}

/**
 * Match a pane's foreground command string against the same shape as
 * `isClaudeCommand` — covers bare `claude`, `claude --foo`, or a path
 * ending in `/claude`. tmux's `pane_current_command` is usually the
 * basename only (`claude`), so this is mostly a cheap == check.
 */
function isPaneClaudeCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (trimmed === "claude") return true;
  // `claude --foo` shouldn't appear here (pane_current_command is the
  // executable basename, not the full argv) but accept it for safety.
  if (trimmed.startsWith("claude ")) return true;
  // Path-prefixed exec.
  if (/(^|\s)\S*\/claude(\s|$)/.test(trimmed)) return true;
  return false;
}

const DESCENDANT_MAX_DEPTH = 6;
const DESCENDANT_MAX_VISITED = 64;

/**
 * BFS the descendant tree rooted at `rootPid`. Returns the first pid we
 * encounter that's present in `targetSet`, or null if the search exceeds
 * its bounds.
 *
 * Uses `pgrep -P <pid>` to list direct children — already allowlisted in
 * safeSpawn's ALLOWED_BINARIES, so no new attack surface.
 */
async function findClaudeDescendant(
  rootPid: number,
  targetSet: Set<number>,
): Promise<number | null> {
  if (targetSet.has(rootPid)) return rootPid;

  const visited = new Set<number>([rootPid]);
  let frontier: number[] = [rootPid];

  for (let depth = 0; depth < DESCENDANT_MAX_DEPTH; depth++) {
    if (frontier.length === 0) return null;
    if (visited.size >= DESCENDANT_MAX_VISITED) return null;

    const nextFrontier: number[] = [];
    for (const pid of frontier) {
      const children = await listChildren(pid);
      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);
        if (targetSet.has(child)) return child;
        nextFrontier.push(child);
        if (visited.size >= DESCENDANT_MAX_VISITED) break;
      }
      if (visited.size >= DESCENDANT_MAX_VISITED) break;
    }
    frontier = nextFrontier;
  }
  return null;
}

/** `pgrep -P <pid>` — direct children of pid. Empty list on exit 1. */
async function listChildren(pid: number): Promise<number[]> {
  let stdout: string;
  try {
    stdout = await execText("pgrep", ["-P", String(pid)]);
  } catch (err) {
    // pgrep exits 1 when nothing matches — that's not an error.
    const exitCode =
      err instanceof Error && "exitCode" in err
        ? (err as { exitCode?: number }).exitCode
        : undefined;
    if (exitCode === 1) return [];
    return [];
  }
  const out: number[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const child = parseInt(trimmed, 10);
    if (Number.isFinite(child) && child > 0) out.push(child);
  }
  return out;
}

export interface ReconcileResult {
  /** Number of rows newly INSERTED by this pass. */
  created: number;
  /** Number of rows transitioned to `status = 'ended'` by this pass. */
  closed: number;
}

// ---------------------------------------------------------------------------
// Watcher tick liveness — exposed via `processWatcherHandle.lastTickMs()`.
// ---------------------------------------------------------------------------
//
// `lastReconcileMs` is a monotonic `performance.now()` reading captured at
// the END of every `reconcileOnce()` call (whether the pass mutated rows or
// not). Readers compute `performance.now() - lastReconcileMs` to get the
// staleness in ms. The sentinel `-1` means "no reconcile has completed yet"
// — the watcher hasn't ticked since process start.
//
// Module-level rather than instance-level because:
//   1. `reconcileOnce()` is exported standalone and called outside the
//      interval loop (e.g. `POST /sessions/probe`). Updating a closure inside
//      `startProcessWatcher` would miss those direct calls.
//   2. There is only one watcher per agent process — no multi-instance
//      isolation requirement to satisfy.
let lastReconcileMs = -1;

// ---------------------------------------------------------------------------
// process-watcher-health-monitoring: tick state surface
// ---------------------------------------------------------------------------
//
// All four fields below are mirrored on the `processWatcherHandle` returned
// by `startProcessWatcher()` (see `lastTickMs()`, `lastReconcileError()`,
// `livePidCount()`, `resolverCacheHitRatio()` getters) AND surfaced on the
// `/health/process-watcher` JSON probe + future `/metrics` endpoint.
//
// Module-level so the standalone `reconcileOnce()` invocation paths
// (`POST /sessions/probe`, tests, on-demand triggers) update the same state
// the interval loop does.

let lastReconcileError: string | null = null;
let lastLivePidCount = 0;
/** Last time we INSERTed into process_watcher_state — drives the prune-every-N-ticks pattern. */
let ticksSinceLastPrune = 0;
/** Keep the last 100 tick rows; prune older every ~10 ticks. */
const TICK_HISTORY_KEEP_ROWS = 100;
/** Stalled threshold — emits ProcessWatcherStalled when tick age exceeds. */
const STALLED_AGE_SECONDS = 30;

/** Cheap monotonic getter — seconds since the last tick completed. -1 if no tick yet. */
function lastTickAgeSeconds(): number {
  if (lastReconcileMs < 0) return -1;
  return Math.max(0, (performance.now() - lastReconcileMs) / 1000);
}

// ponytail: one global in-flight latch — a single watcher runs per agent
// process, so a process-wide coalesce is sufficient. Per-db keying would be
// speculative. Every caller (tick + probe) uses the one agent db.
let inFlightReconcile: Promise<ReconcileResult> | null = null;

/**
 * Single reconciliation pass, serialized. Exposed standalone so the
 * `POST /sessions/probe` route handler can trigger it on demand without
 * racing the interval `tick()` (which would double-INSERT new PIDs — the id
 * is minted fresh per pass and `pid` has no unique constraint).
 * Concurrent callers coalesce onto the one in-flight pass.
 */
export function reconcileOnce(db: Db): Promise<ReconcileResult> {
  if (inFlightReconcile) return inFlightReconcile;
  const pass = reconcileOncePass(db).finally(() => {
    inFlightReconcile = null;
  });
  inFlightReconcile = pass;
  return pass;
}

/**
 * process-watcher-health-monitoring: records tick duration, live pid count,
 * and error text into `process_watcher_state` on every tick. Emits
 * `ProcessWatcherStalled` on the lifecycle bus when the LATEST row
 * carries an error or this tick's duration exceeds the stalled threshold.
 */
async function reconcileOncePass(db: Db): Promise<ReconcileResult> {
  const tickStartMs = performance.now();
  let tickErrorText: string | null = null;

  let live: LiveProcess[] | null = [];
  try {
    live = await listClaudeProcesses();
  } catch (err) {
    tickErrorText = err instanceof Error ? err.message : String(err);
    log.warn({ err: tickErrorText }, "listClaudeProcesses threw inside reconcileOnce");
    live = null;
  }
  // A failed scan (null) is NOT "nothing alive". Do NOT close managed rows
  // on a scan failure — a single flaky pgrep tick would otherwise mark every
  // open session ended and storm RemoteSessionEnded to every client.
  const scanFailed = live === null;
  if (scanFailed && tickErrorText === null) {
    tickErrorText = "pgrep scan failed; row reconciliation skipped this tick";
  }
  const liveList = live ?? [];
  const livePids = new Set(liveList.map((p) => p.pid));
  lastLivePidCount = livePids.size;

  // Step 1b (nx-ds6rq): tmux is the authoritative source for cwd +
  // tmuxTarget. Walk every pane whose foreground command is `claude`,
  // descend the process tree, and pin each live claude pid to its pane's
  // cwd + canonical `<session>:<window>.<pane>` address. Fail-soft: if no
  // tmux server is reachable, this returns an empty map and the watcher
  // falls back to PID-only detection (rows get cwd="" until a CC hook
  // arrives).
  const paneByPid = await tmuxScan(livePids);

  // Step 1: select open rows the watcher already manages (pid IS NOT NULL,
  // pid > 0). Rows lacking a pid are legacy and left alone — they MAY be
  // managed by hook-driven session_start payloads which carry their own
  // tmux/cc identifiers but no PID.
  //
  // session-row-enrichment-v1 § 1.4: also load `cwd` + `gitProvider` so we
  // can re-enrich existing null-project rows on subsequent polls (spec
  // scenario "existing null-project row gets enriched on next poll").
  // nx-ds6rq: also load `tmuxTarget` so we can backfill tmux-derived
  // cwd/tmuxTarget onto legacy rows whose hook fired before tmuxScan
  // landed.
  const openRows = await db
    .select({
      id: sessions.id,
      pid: sessions.pid,
      cwd: sessions.cwd,
      tmuxTarget: sessions.tmuxTarget,
      gitProvider: sessions.gitProvider,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, "active"),
        isNull(sessions.endedAt),
        isNotNull(sessions.pid),
        gt(sessions.pid, 0),
      ),
    );

  const managedPids = new Set<number>();
  // PIDs that already have an open row AND are still alive — these get a
  // liveness heartbeat so a long-running session between CC hook events does
  // not go stale and fall out of the dashboard's freshness window.
  const liveManagedPids: number[] = [];
  // session-row-enrichment-v1 § 1.4: existing alive rows whose git_provider
  // is still null get re-enriched on each poll (spec scenario "existing
  // null-project row gets enriched on next poll"). The 30s resolver cache
  // keeps this cheap even across many sessions in the same cwd.
  const needsEnrichment: Array<{ id: string; cwd: string }> = [];
  // nx-ds6rq: alive rows whose cwd or tmuxTarget is still blank but whose
  // pid matched a pane this tick get backfilled inline. Distinct from
  // `needsEnrichment` because this is the row-fill step, not the
  // git-resolver step.
  const needsTmuxFill: Array<{ id: string; cwd: string; tmuxTarget: string }> = [];
  let closed = 0;
  const now = new Date();

  for (const row of openRows) {
    const pid = row.pid;
    if (pid === null || pid <= 0) continue;
    managedPids.add(pid);
    if (livePids.has(pid)) {
      liveManagedPids.push(pid);

      // nx-ds6rq + nx-tmuxdrift: tmux-derived backfill AND drift-repair for
      // alive managed rows. tmuxTarget is ephemeral — tmux renumbers windows
      // when one is closed, so a live pid (stable identity) can move panes.
      // The stored target then points at a dead pane and PTY attach 404s.
      // Refresh whenever the live scan differs from the stored value.
      const pane = paneByPid.get(pid);
      if (pane) {
        const cwdBlank = !(row.cwd ?? "").trim();
        const storedTarget = (row.tmuxTarget ?? "").trim();
        const tmuxBlank = storedTarget === "";
        const tmuxStale = !tmuxBlank && storedTarget !== pane.tmuxTarget;
        if (cwdBlank || tmuxBlank || tmuxStale) {
          needsTmuxFill.push({
            id: row.id,
            // Don't clobber a good cwd with an empty pane.cwd; prefer the
            // fresh pane cwd when present, else keep the existing row cwd.
            cwd: (pane.cwd ?? "").trim() || (row.cwd ?? ""),
            tmuxTarget: pane.tmuxTarget,
          });
        }
      }

      if (!row.gitProvider) {
        // Re-enrich existing rows whose git_provider is still null but
        // whose cwd is known. cwd can land via:
        //   - a prior CC `session_start` hook payload (legacy path), OR
        //   - this poll's tmuxScan match (nx-ds6rq).
        // Either way the resolver call is identical.
        const effectiveCwd = (pane?.cwd ?? row.cwd ?? "").trim();
        if (effectiveCwd) {
          needsEnrichment.push({ id: row.id, cwd: effectiveCwd });
        }
      }
    }
    if (!scanFailed && !livePids.has(pid)) {
      try {
        await db
          .update(sessions)
          .set({ status: "ended", endedAt: now, lastActivity: now })
          .where(eq(sessions.id, row.id));
        closed += 1;
        lifecycleBus.emit("RemoteSessionEnded", {
          sessionId: row.id,
          pid,
        });
      } catch (err) {
        log.warn(
          { id: row.id, pid, error: err instanceof Error ? err.message : String(err) },
          "failed to close session row",
        );
      }
    }
  }

  // Step 1c (was 1b): refresh last_activity for live, already-managed PIDs
  // (single batched UPDATE). Process-aliveness is a valid liveness signal
  // even when no CC hook fired this interval.
  try {
    await touchHeartbeatByPids(db, liveManagedPids);
  } catch (err) {
    log.warn(
      {
        count: liveManagedPids.length,
        error: err instanceof Error ? err.message : String(err),
      },
      "failed to refresh last_activity for live managed PIDs",
    );
  }

  // Step 1d (nx-ds6rq): backfill tmux-derived cwd + tmuxTarget onto alive
  // rows that were inserted before tmuxScan landed (or before the pane was
  // visible to the watcher). Independent of the resolver loop below — that
  // one needs cwd to already be persisted to query, but we can write both
  // cwd + tmuxTarget here in a single UPDATE.
  for (const row of needsTmuxFill) {
    try {
      await db
        .update(sessions)
        .set({ cwd: row.cwd, tmuxTarget: row.tmuxTarget })
        .where(eq(sessions.id, row.id));
    } catch (err) {
      log.warn(
        {
          id: row.id,
          cwd: row.cwd,
          tmuxTarget: row.tmuxTarget,
          error: err instanceof Error ? err.message : String(err),
        },
        "failed to backfill tmux-derived cwd/tmuxTarget on session row (non-fatal)",
      );
    }
  }

  // Step 1c: re-enrich any live row that's still missing git project metadata
  // (session-row-enrichment-v1 § 1.4). The resolver's 30s cache means this
  // is at-most one subprocess per unique cwd per poll cycle. Each call is
  // independent and fail-soft.
  for (const row of needsEnrichment) {
    try {
      const project = await resolveProject(row.cwd, db);
      if (!project) continue;
      await updateSessionGitOrigin(db, row.id, {
        provider: project.provider,
        ownerRepo: project.ownerRepo,
      });
      if (project.projectId) {
        await db
          .update(sessions)
          .set({ projectId: project.projectId })
          .where(eq(sessions.id, row.id));
      }
    } catch (err) {
      log.warn(
        {
          id: row.id,
          cwd: row.cwd,
          error: err instanceof Error ? err.message : String(err),
        },
        "failed to re-enrich session row with git project (non-fatal)",
      );
    }
  }

  // Step 2: open rows for live PIDs we haven't seen yet.
  //
  // nx-ds6rq: if the PID matched a tmux pane this tick, cwd + tmuxTarget
  // come straight from tmux (`pane_current_path`, `<session>:<window>.<pane>`)
  // and the git-project resolver fires inline so the row lands fully
  // populated. Otherwise cwd is empty and enrichment is deferred to a
  // later poll once a hook supplies cwd. The watcher never reads
  // /proc/<pid>/cwd — that path is blocked by Yama=1 under user-instance
  // systemd (nx-9jz0v).
  let created = 0;
  for (const proc of liveList) {
    if (managedPids.has(proc.pid)) continue;
    const sessionId = `cc-${proc.pid}-${randomUUID().slice(0, 8)}`;

    const pane = paneByPid.get(proc.pid);
    const cwd = pane?.cwd ?? "";
    const tmuxTarget = pane?.tmuxTarget ?? null;

    // Inline git-project resolution when we have a cwd. Skipping when cwd
    // is blank avoids a useless `git remote get-url` call.
    let resolvedProject: Awaited<ReturnType<typeof resolveProject>> = null;
    if (cwd) {
      try {
        resolvedProject = await resolveProject(cwd, db);
      } catch (err) {
        log.warn(
          {
            pid: proc.pid,
            cwd,
            error: err instanceof Error ? err.message : String(err),
          },
          "resolveProject failed for new claude pid (non-fatal)",
        );
      }
    }

    // session-enrichment: fail-soft, cwd-memoised git branch lookup. Skipped
    // when cwd is blank (no dir to inspect). resolveBranch never throws —
    // non-git dirs / failures return null, so `branch` stays null exactly as
    // before for those cases.
    const branch = cwd ? await resolveBranch(cwd) : null;

    try {
      await upsertSession(db, {
        id: sessionId,
        pid: proc.pid,
        project: undefined,
        projectId: resolvedProject?.projectId ?? null,
        machine: "local",
        cwd,
        branch,
        startedAt: now,
        lastHeartbeat: now,
        endedAt: null,
        status: "active",
        spec: null,
        command: null,
        agent: null,
        tmuxSession: null,
        ccSessionId: null,
        tmuxTarget,
        rateLimitUtilization: null,
        rateLimitType: null,
        totalCostUsd: null,
        model: "claude",
        credentialId: null,
        credentialFingerprint: null,
        sessionType: "managed",
        // session-enrichment: no hook observed yet at discovery time. The
        // hook-processing spine sets blocked/waiting/ready on the first
        // lifecycle hook.
        agentState: null,
        parentSessionId: null,
        childRole: null,
      });
      created += 1;

      // Persist git provider + owner/repo if the resolver landed a hit.
      // upsertSession doesn't carry these fields directly — they're owned
      // by updateSessionGitOrigin so the normalization rules live in one
      // place.
      if (resolvedProject) {
        try {
          await updateSessionGitOrigin(db, sessionId, {
            provider: resolvedProject.provider,
            ownerRepo: resolvedProject.ownerRepo,
          });
        } catch (err) {
          log.warn(
            {
              sessionId,
              cwd,
              error: err instanceof Error ? err.message : String(err),
            },
            "failed to persist git origin for new session (non-fatal)",
          );
        }
      }

      lifecycleBus.emit("RemoteSessionStarted", {
        sessionId,
        pid: proc.pid,
        cwd: cwd || null,
        model: "claude",
        tmuxTarget,
        machine: "local",
      });
    } catch (err) {
      log.warn(
        { pid: proc.pid, error: err instanceof Error ? err.message : String(err) },
        "failed to insert session row for new claude process",
      );
    }
  }

  if (created > 0 || closed > 0) {
    log.info({ created, closed, live: liveList.length }, "reconciliation pass complete");
  }

  // process-watcher-health-monitoring: tick-level counters.
  if (created > 0) incPidsOpened(created);
  if (closed > 0) incPidsClosed(closed);

  // Stamp the watcher heartbeat — read by `processWatcherHandle.lastTickMs()`
  // and surfaced on `GET /health.last_watcher_tick_ms`.
  lastReconcileMs = performance.now();
  lastReconcileError = tickErrorText;

  // process-watcher-health-monitoring: persist tick + emit stalled event.
  // Both side-effects are fail-soft — they MUST NOT mask the reconcile
  // result (the caller has already done the real work).
  const tickDurationMs = Math.round(performance.now() - tickStartMs);
  recordTickDurationMs(tickDurationMs);
  await persistTickRow(db, {
    livePidCount: livePids.size,
    tickDurationMs,
    errorText: tickErrorText,
  });
  await maybeEmitStalled(db, {
    livePidCount: livePids.size,
    tickDurationMs,
    errorText: tickErrorText,
  });

  return { created, closed };
}

// ---------------------------------------------------------------------------
// process-watcher-health-monitoring helpers
// ---------------------------------------------------------------------------

/**
 * Append a row to `process_watcher_state` and opportunistically prune
 * older rows so the table stays bounded at ~100 entries.
 */
async function persistTickRow(
  db: Db,
  row: { livePidCount: number; tickDurationMs: number; errorText: string | null },
): Promise<void> {
  try {
    await db.insert(processWatcherState).values({
      livePidCount: row.livePidCount,
      tickDurationMs: row.tickDurationMs,
      errorText: row.errorText,
    });

    ticksSinceLastPrune += 1;
    if (ticksSinceLastPrune >= 10) {
      ticksSinceLastPrune = 0;
      try {
        // Keep only the latest TICK_HISTORY_KEEP_ROWS rows. Implementation
        // uses a subselect for portability across PG versions; on this
        // table (tiny, append-only) the extra round-trip is irrelevant.
        await db.execute(
          sql`DELETE FROM ${processWatcherState} WHERE id NOT IN (
            SELECT id FROM ${processWatcherState}
            ORDER BY observed_at DESC
            LIMIT ${TICK_HISTORY_KEEP_ROWS}
          )`,
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "process_watcher_state prune failed (non-fatal)",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "process_watcher_state INSERT failed (non-fatal)",
    );
  }
}

/**
 * Emit `ProcessWatcherStalled` when this tick's duration exceeds the stalled
 * threshold (>30s) OR `errorText` is set. Idempotent on the bus side; no
 * rate limiting here — back-to-back stalled ticks each fire one event so
 * subscribers see the streak.
 */
async function maybeEmitStalled(
  _db: Db,
  row: { livePidCount: number; tickDurationMs: number; errorText: string | null },
): Promise<void> {
  const stalled =
    row.errorText !== null || row.tickDurationMs > STALLED_AGE_SECONDS * 1000;
  if (!stalled) return;

  try {
    lifecycleBus.emit("ProcessWatcherStalled", {
      tickAgeSeconds: row.tickDurationMs / 1000,
      errorText: row.errorText,
      livePidCount: row.livePidCount,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ProcessWatcherStalled emit failed (non-fatal)",
    );
  }
}

/**
 * Count rows in `sessions` whose pid is set but no longer alive — the
 * "stale rows" the watcher would close on the next tick. Used by the
 * `/health/process-watcher` probe + `nexus_pw_stale_rows` gauge.
 *
 * Best-effort: returns 0 on any error.
 */
export async function staleRowCount(db: Db): Promise<number> {
  try {
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM sessions
          WHERE status = 'active'
            AND ended_at IS NULL
            AND pid IS NOT NULL
            AND pid > 0`,
    );
    // drizzle returns a different shape per driver; reach into rows
    const rows = (result as unknown as { rows?: Array<{ count: number }> }).rows
      ?? (result as unknown as Array<{ count: number }>);
    const first = Array.isArray(rows) ? rows[0] : undefined;
    return first?.count ?? 0;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "staleRowCount query failed (returning 0)",
    );
    return 0;
  }
}

// Suppress unused-import warning for lt — kept for future window queries
// against process_watcher_state.observed_at.
void lt;

export interface ProcessWatcherHandle {
  /** Stop the interval loop. Safe to call multiple times. */
  stop(): void;
  /**
   * Monotonic ms since the watcher's `reconcileOnce()` last completed.
   * Returns `-1` when the watcher has not ticked yet since process start.
   */
  lastTickMs(): number;
  /**
   * Error message from the most recent failed tick path (e.g. pgrep
   * crash), or `null` when the latest tick succeeded.
   * Spec: process-watcher-health-monitoring.
   */
  lastReconcileError(): string | null;
  /** Number of live `claude` pids observed by the most recent tick. */
  livePidCount(): number;
  /**
   * Hit ratio for the git-project resolver's in-process cache.
   * Returns 0 when no lookups have happened since process start.
   */
  resolverCacheHitRatio(): number;
}

/**
 * Standalone accessor for the watcher tick liveness, useful when the caller
 * doesn't hold a handle (e.g. tests, `reconcileOnce()` ad-hoc invocations).
 */
export function lastWatcherTickMs(): number {
  if (lastReconcileMs < 0) return -1;
  return Math.max(0, performance.now() - lastReconcileMs);
}

/**
 * Start a 30-second reconciliation loop. The returned handle MUST be
 * retained so the server can stop the watcher on graceful shutdown.
 *
 * The first pass fires immediately so newly-restarted agents converge
 * without waiting a full interval.
 */
export function startProcessWatcher(
  db: Db,
  opts?: { intervalMs?: number },
): ProcessWatcherHandle {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const tick = async () => {
    if (stopped) return;
    if (running) {
      // Skip overlapping tick — keep cadence honest.
      timer = setTimeout(tick, intervalMs);
      return;
    }
    running = true;
    try {
      await reconcileOnce(db);
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "reconcileOnce threw",
      );
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
      }
    }
  };

  // Fire-and-forget first pass; the next tick is scheduled inside `tick`.
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    lastTickMs() {
      return lastWatcherTickMs();
    },
    lastReconcileError() {
      return lastReconcileError;
    },
    livePidCount() {
      return lastLivePidCount;
    },
    resolverCacheHitRatio() {
      return resolverCacheStats().ratio;
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone getters — usable by callers that don't hold the handle
// ---------------------------------------------------------------------------

/** Same as `handle.lastReconcileError()` — standalone form for routes/tests. */
export function lastWatcherReconcileError(): string | null {
  return lastReconcileError;
}

/** Same as `handle.livePidCount()` — standalone form for routes/tests. */
export function lastWatcherLivePidCount(): number {
  return lastLivePidCount;
}

/** Same as `handle.resolverCacheHitRatio()` — standalone form for routes/tests. */
export function watcherResolverCacheHitRatio(): number {
  return resolverCacheStats().ratio;
}

/** Expose the stalled threshold to consumers (e.g. the health probe). */
export function watcherStalledAgeSeconds(): number {
  return STALLED_AGE_SECONDS;
}

/** Suppress side-effect import warning if the gauge is unused inline. */
void setStaleRowsGauge;

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __testing = {
  isClaudeCommand,
  isPaneClaudeCommand,
  listClaudeProcesses,
  listTmuxPanes,
  tmuxScan,
  resolveBranch,
  clearBranchCache,
};
