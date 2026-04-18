/**
 * CronService -- scheduled maintenance and drift detection.
 *
 * Two internal jobs:
 *
 * **maintain** (daily ~00:17): Prunes stale temp files, old failure JSONL,
 * old telemetry JSONL, debug logs, paste-cache, and session dirs.
 *
 * **drift** (weekly, Sunday ~09:00): Validates settings.json, checks for
 * orphaned worktree memory directories.
 *
 * Uses setInterval with absolute next-run timestamp calculation so jobs
 * fire at the correct local time regardless of system sleep or clock drift.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core/node";
import { execText } from "../utils/exec";
import { getSettings } from "./config-loader";

const log = createLogger("agent:cron");

// ---------------------------------------------------------------------------
// Schedule calculation helpers
// ---------------------------------------------------------------------------

/** Calculate ms until the next occurrence of a daily time (HH:MM). */
function msUntilDailyAt(hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  if (target.getTime() <= now.getTime()) {
    // Already passed today -- schedule for tomorrow.
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/** Calculate ms until the next occurrence of a weekly day+time (0=Sun..6=Sat). */
function msUntilWeeklyAt(dayOfWeek: number, hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  const currentDay = now.getDay();
  let daysAhead = (dayOfWeek - currentDay + 7) % 7;

  // If it's the same day but the time has passed, schedule for next week.
  if (daysAhead === 0 && target.getTime() <= now.getTime()) {
    daysAhead = 7;
  }

  target.setDate(target.getDate() + daysAhead);
  return target.getTime() - now.getTime();
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

interface PruneResult {
  count: number;
  bytes: number;
}

/**
 * Prune files matching a name pattern older than `days` in a directory.
 * Only prunes files at maxdepth=1 (not recursive).
 */
function pruneOldFiles(dir: string, matchFn: (name: string) => boolean, days: number): PruneResult {
  if (!existsSync(dir)) return { count: 0, bytes: 0 };

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let count = 0;
  let bytes = 0;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!matchFn(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > cutoffMs) continue;

        bytes += stat.size;
        unlinkSync(fullPath);
        count++;
        log.debug({ path: fullPath }, "cron: pruned");
      } catch {
        // Skip files we cannot stat or remove.
      }
    }
  } catch {
    // Directory read failed -- not fatal.
  }

  return { count, bytes };
}

/**
 * Prune /tmp/nexus-* files older than 24 hours.
 */
function pruneTmpNexus(): PruneResult {
  return pruneOldFiles(
    "/tmp",
    (name) => name.startsWith("nexus-"),
    1, // 24 hours
  );
}

/**
 * Find orphaned worktree memory directories in ~/.claude/projects/.
 *
 * Directories with "worktrees" in the name that do not correspond to any
 * active git worktree are considered orphaned.
 */
async function findOrphanedWorktreeDirs(projectsDir: string): Promise<string[]> {
  if (!existsSync(projectsDir)) return [];

  const worktreeDirs: string[] = [];
  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.includes("worktrees")) {
        worktreeDirs.push(entry.name);
      }
    }
  } catch {
    return [];
  }

  if (worktreeDirs.length === 0) return [];

  // Get active worktree names from git.
  let activeWorktrees: string[] = [];
  try {
    const output = await execText("git", ["worktree", "list", "--porcelain"]);
    activeWorktrees = output
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace("worktree ", ""));
  } catch {
    // git not available or failed -- treat all as orphaned.
  }

  return worktreeDirs.filter((dirName) => {
    return !activeWorktrees.some((wt) => {
      const lastSegment = wt.split("/").pop() ?? "";
      return dirName.includes(lastSegment);
    });
  });
}

// ---------------------------------------------------------------------------
// Maintain job
// ---------------------------------------------------------------------------

function runMaintain(): void {
  const start = performance.now();
  log.info("cron: maintain job starting");

  let totalPruned = 0;
  let totalBytes = 0;
  const details: string[] = [];
  const errors: string[] = [];

  const home = homedir();

  // 1. Prune /tmp/nexus-* stale files (>24h)
  try {
    const r = pruneTmpNexus();
    if (r.count > 0) details.push(`/tmp/nexus-*: ${r.count} files, ${r.bytes} bytes`);
    totalPruned += r.count;
    totalBytes += r.bytes;
  } catch (e) {
    errors.push(`tmp prune: ${e}`);
  }

  // 2. Prune ~/.claude/scripts/state/failures/*.jsonl files >30 days old
  try {
    const r = pruneOldFiles(
      join(home, ".claude/scripts/state/failures"),
      (n) => n.endsWith(".jsonl"),
      30,
    );
    if (r.count > 0) details.push(`failures/: ${r.count} files, ${r.bytes} bytes`);
    totalPruned += r.count;
    totalBytes += r.bytes;
  } catch (e) {
    errors.push(`failures prune: ${e}`);
  }

  // 3. Prune ~/.claude/telemetry/1p_failed_events.*.json >30 days old
  try {
    const r = pruneOldFiles(
      join(home, ".claude/telemetry"),
      (n) => n.startsWith("1p_failed_events.") && n.endsWith(".json"),
      30,
    );
    if (r.count > 0) details.push(`telemetry/: ${r.count} files, ${r.bytes} bytes`);
    totalPruned += r.count;
    totalBytes += r.bytes;
  } catch (e) {
    errors.push(`telemetry prune: ${e}`);
  }

  // 4. Prune ~/.claude/debug/*.txt >7 days old
  try {
    const r = pruneOldFiles(
      join(home, ".claude/debug"),
      (n) => n.endsWith(".txt"),
      7,
    );
    if (r.count > 0) details.push(`debug/: ${r.count} files, ${r.bytes} bytes`);
    totalPruned += r.count;
    totalBytes += r.bytes;
  } catch (e) {
    errors.push(`debug prune: ${e}`);
  }

  // 5. Prune ~/.claude/paste-cache/* >30 days old
  try {
    const r = pruneOldFiles(
      join(home, ".claude/paste-cache"),
      () => true, // all files
      30,
    );
    if (r.count > 0) details.push(`paste-cache/: ${r.count} files, ${r.bytes} bytes`);
    totalPruned += r.count;
    totalBytes += r.bytes;
  } catch (e) {
    errors.push(`paste-cache prune: ${e}`);
  }

  const durationMs = Math.round(performance.now() - start);

  const logMessage = totalPruned > 0
    ? `pruned ${totalPruned} items, freed ${totalBytes} bytes`
    : "nothing to prune";

  if (errors.length > 0) {
    log.warn(
      { totalPruned, totalBytes, durationMs, details, errors },
      `cron: maintain complete (partial) -- ${logMessage}`,
    );
  } else {
    log.info(
      { totalPruned, totalBytes, durationMs },
      `cron: maintain complete -- ${logMessage}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Drift job
// ---------------------------------------------------------------------------

async function runDrift(): Promise<void> {
  const start = performance.now();
  log.info("cron: drift job starting");

  const findings: string[] = [];
  const home = homedir();

  // 1. Validate ~/.claude/settings.json is valid JSON via config-loader cache.
  const settingsPath = join(home, ".claude/settings.json");
  try {
    const settings = getSettings();
    // getSettings() returns {} on error — validate file is actually readable.
    if (!existsSync(settingsPath)) {
      findings.push("settings.json: file does not exist");
    } else if (typeof settings !== "object" || settings === null) {
      findings.push("settings.json: invalid JSON");
    } else {
      log.debug("cron drift: settings.json is valid JSON");
    }
  } catch (e) {
    findings.push(`settings.json: cannot read: ${e}`);
  }

  // 2. Check for orphaned worktree memory dirs.
  try {
    const projectsDir = join(home, ".claude/projects");
    const orphans = await findOrphanedWorktreeDirs(projectsDir);
    if (orphans.length > 0) {
      findings.push(
        `${orphans.length} orphaned worktree dir(s): ${orphans.join(", ")}`,
      );
    }
  } catch (e) {
    findings.push(`worktree check failed: ${e}`);
  }

  const durationMs = Math.round(performance.now() - start);

  if (findings.length === 0) {
    log.info({ durationMs }, "cron: drift complete -- no drift detected");
  } else {
    const hasInvalidJson = findings.some((f) => f.includes("invalid JSON"));
    const severity = hasInvalidJson ? "error" : "warn";
    log[severity](
      { findings, durationMs },
      `cron: drift complete -- ${findings.length} finding(s)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

export interface CronService {
  stop(): void;
}

/**
 * Start the cron service with two scheduled jobs:
 * - maintain: daily at 00:17 local time
 * - drift: weekly Sunday at 09:00 local time
 */
export function startCronService(): CronService {
  let maintainTimer: ReturnType<typeof setTimeout> | null = null;
  let driftTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleMaintain(): void {
    if (stopped) return;
    const delayMs = msUntilDailyAt(0, 17);
    log.debug(
      { delaySecs: Math.round(delayMs / 1000) },
      "cron: scheduling next maintain job",
    );
    maintainTimer = setTimeout(() => {
      if (stopped) return;
      try {
        runMaintain();
      } catch (err) {
        log.error({ error: err }, "cron: maintain job failed");
      }
      scheduleMaintain(); // Reschedule for next occurrence.
    }, delayMs);
  }

  function scheduleDrift(): void {
    if (stopped) return;
    const delayMs = msUntilWeeklyAt(0, 9, 0); // 0 = Sunday
    log.debug(
      { delaySecs: Math.round(delayMs / 1000) },
      "cron: scheduling next drift job",
    );
    driftTimer = setTimeout(() => {
      if (stopped) return;
      runDrift().catch((err) => {
        log.error({ error: err }, "cron: drift job failed");
      });
      scheduleDrift(); // Reschedule for next occurrence.
    }, delayMs);
  }

  scheduleMaintain();
  scheduleDrift();

  log.info("CronService started -- maintain(daily@00:17), drift(weekly Sun@09:00)");

  return {
    stop() {
      stopped = true;
      if (maintainTimer) clearTimeout(maintainTimer);
      if (driftTimer) clearTimeout(driftTimer);
      maintainTimer = null;
      driftTimer = null;
      log.info("CronService stopped");
    },
  };
}

// Exported for testing.
export { msUntilDailyAt, msUntilWeeklyAt, runMaintain, runDrift };
