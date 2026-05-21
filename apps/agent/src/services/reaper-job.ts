/**
 * reaper-job — TS wrapper around `reaper-core.sh`.
 *
 * Spec: openspec/changes/adopt-reaper-into-nx-cron (cron-persistence capability).
 *
 * The wrapper owns ONLY orchestration: spawn the bash core as a child
 * process, forward `--dry-run`, capture stdout/stderr, parse the
 * machine-parseable `NEXUS_RESULT` / `NEXUS_BLOAT` lines, persist the run to
 * `cron_runs` + `bloat_radar`, and emit a `NotificationFired` payload via
 * the lifecycle bus.
 *
 * The destructive logic lives entirely in `reaper-core.sh` — re-writing
 * the destructive guards in TS would re-litigate a solved, incident-
 * hardened problem (see proposal.md `Accepted Risk` + `Destructive-Safety
 * Invariants` sections).
 *
 * Lines emitted by `reaper-core.sh` and consumed here:
 *   - "NEXUS_RESULT started_at=… dry_run=… log_path=…"          (Phase 1)
 *   - "NEXUS_BLOAT label=<l>|path=<p>|size_bytes=<sz>|threshold_bytes=<th>"
 *     (zero or more after the completion sentinel — clear run = none)
 *   - "NEXUS_RESULT status=success pruned=… freed_bytes=… log_path=…"
 *     (final terminal line)
 *   - "NEXUS_RESULT status=aborted rc=… log_path=…"
 *     (emitted by the `_on_exit` trap on any early exit)
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core/node";
import type { Db, NewBloatRadar, NewCronRun } from "@nexus/db";
import { bloatRadar, cronRuns } from "@nexus/db";
import { lifecycleBus } from "./lifecycle-bus";

const log = createLogger("agent:reaper-job");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ReaperStatus = "success" | "failure" | "aborted";

export interface ReaperBloatFinding {
  label: string;
  path: string;
  sizeBytes: number;
  thresholdBytes: number;
}

export interface ReaperResult {
  status: ReaperStatus;
  pruned: number;
  freedBytes: number;
  durationMs: number;
  bloatFindings: ReaperBloatFinding[];
  logPath: string;
  /** Raw stdout — captured for tests + future debugging. */
  stdout: string;
  /** Raw stderr — usually empty (the script redirects 2>&1 into the log). */
  stderr: string;
}

export interface RunReaperOptions {
  /** Pass `--dry-run` to the bash core. Defaults to `false`. */
  dryRun?: boolean;
  /** Override the script path — used by tests. */
  scriptPath?: string;
  /**
   * Max wall-clock for the child process. The historical script can take
   * several minutes on a cold-cache machine; default to 30 minutes.
   */
  timeoutMs?: number;
  /** Override `bash` binary — used by tests. */
  bashBin?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

/** Absolute path to the vendored bash core. */
export function defaultScriptPath(): string {
  // import.meta.dir resolves to apps/agent/src/services at runtime.
  // Avoid the `dist/` flavor in production by using the .sh sibling.
  return join(import.meta.dir, "reaper-core.sh");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface ParsedOutput {
  status: ReaperStatus;
  pruned: number;
  freedBytes: number;
  bloatFindings: ReaperBloatFinding[];
  logPath: string;
  startedAt: string | null;
  rc: number | null;
}

/**
 * Parse the bash core's stdout. The parser is deliberately permissive —
 * absent fields default to `0`/empty rather than throwing, so a partially-
 * written stdout (e.g. on signal) still yields a usable result row.
 *
 * Exported for unit tests.
 */
export function parseReaperOutput(stdout: string): ParsedOutput {
  const out: ParsedOutput = {
    status: "failure",
    pruned: 0,
    freedBytes: 0,
    bloatFindings: [],
    logPath: "",
    startedAt: null,
    rc: null,
  };

  const lines = stdout.split("\n");

  for (const line of lines) {
    if (line.startsWith("NEXUS_BLOAT ")) {
      const finding = parseBloatLine(line.slice("NEXUS_BLOAT ".length));
      if (finding) out.bloatFindings.push(finding);
      continue;
    }

    if (line.startsWith("NEXUS_RESULT ")) {
      const fields = parseResultLine(line.slice("NEXUS_RESULT ".length));

      if (fields.started_at) out.startedAt = fields.started_at;
      if (fields.log_path) out.logPath = fields.log_path;

      if (fields.status === "success") {
        out.status = "success";
        out.pruned = toInt(fields.pruned, 0);
        out.freedBytes = toInt(fields.freed_bytes, 0);
      } else if (fields.status === "aborted") {
        out.status = "aborted";
        out.rc = toInt(fields.rc, 0);
      }
    }
  }

  return out;
}

/** Parse a `key=value key=value` space-delimited line. */
function parseResultLine(rest: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Split on spaces, but be tolerant of values with no spaces (the bash
  // emitter writes ISO timestamps without spaces and paths without spaces).
  for (const tok of rest.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    result[key] = value;
  }
  return result;
}

/** Parse a pipe-delimited NEXUS_BLOAT body. */
function parseBloatLine(rest: string): ReaperBloatFinding | null {
  const fields: Record<string, string> = {};
  for (const tok of rest.split("|")) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }

  const label = fields.label;
  const path = fields.path;
  if (!label || !path) return null;

  return {
    label,
    path,
    sizeBytes: toInt(fields.size_bytes, 0),
    thresholdBytes: toInt(fields.threshold_bytes, 0),
  };
}

function toInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Spawn `reaper-core.sh` and return a structured result. Never throws on a
 * non-zero exit — the bash core's `_on_exit` trap reports `status=aborted`
 * via stdout and the wrapper surfaces it as a `failure`/`aborted` result.
 */
export async function runReaper(opts: RunReaperOptions = {}): Promise<ReaperResult> {
  const scriptPath = opts.scriptPath ?? defaultScriptPath();
  const dryRun = opts.dryRun ?? false;
  const bashBin = opts.bashBin ?? "bash";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [scriptPath];
  if (dryRun) args.push("--dry-run");

  const start = performance.now();
  log.info({ scriptPath, dryRun }, "reaper: spawning core");

  // Resolve the log file path under the same $HOME the bash core uses, so
  // the wrapper can tee stdout into it. Mirrors `reaper-core.sh:LOG_FILE`.
  const home = process.env.HOME ?? homedir();
  const logFilePath = join(home, ".local", "state", "weekly-cleanup.log");
  try {
    mkdirSync(join(home, ".local", "state"), { recursive: true });
  } catch {
    // best-effort
  }

  const proc = Bun.spawn([bashBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Explicitly forward `process.env` so tests that override $HOME on the
    // parent process propagate to the child (`Bun.spawn` defaults to a
    // sanitized env on some platforms). NEXUS_REAPER_NO_REDIRECT=1 tells
    // the bash core to leave stdout/stderr untouched so the wrapper can
    // parse the NEXUS_RESULT / NEXUS_BLOAT lines AND tee them to the log
    // file on the parent side.
    env: { ...process.env, NEXUS_REAPER_NO_REDIRECT: "1" },
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // best-effort
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const exitCode = await proc.exited;
  const durationMs = Math.round(performance.now() - start);

  // Tee captured output into the per-run log file. Replaces the `exec >>`
  // redirection the chezmoi original did inside the script — see the
  // NEXUS_REAPER_NO_REDIRECT branch in reaper-core.sh.
  try {
    const header = `=== nexus-agent invocation $(parent-pid=${process.pid}) ===\n`;
    appendFileSync(logFilePath, header + stdout + (stderr ? `\n--- stderr ---\n${stderr}\n` : ""));
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err), logFilePath },
      "reaper: failed to tee stdout to log file (non-fatal)",
    );
  }

  const parsed = parseReaperOutput(stdout);

  // Final status resolution: trust the parsed status when present, but
  // override to `aborted` on timeout (the trap line may not have flushed)
  // or `failure` on a non-zero exit that the parser saw as `success`
  // (defensive — should not happen in practice).
  let status: ReaperStatus = parsed.status;
  if (timedOut) status = "aborted";
  else if (exitCode !== 0 && status === "success") status = "failure";

  const result: ReaperResult = {
    status,
    pruned: parsed.pruned,
    freedBytes: parsed.freedBytes,
    durationMs,
    bloatFindings: parsed.bloatFindings,
    logPath: parsed.logPath,
    stdout,
    stderr,
  };

  log.info(
    {
      status: result.status,
      pruned: result.pruned,
      freedBytes: result.freedBytes,
      durationMs: result.durationMs,
      bloatCount: result.bloatFindings.length,
      exitCode,
      timedOut,
    },
    "reaper: core finished",
  );

  return result;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistReaperResultOpts {
  db: Db;
  result: ReaperResult;
  /** Defaults to `new Date()` — overridable for deterministic tests. */
  timestamp?: Date;
}

/**
 * Persist the wrapper result to `cron_runs` and any bloat findings to
 * `bloat_radar`. Returns the inserted cron_runs row id (helpful for
 * downstream wiring and tests).
 */
export async function persistReaperResult(
  opts: PersistReaperResultOpts,
): Promise<{ cronRunId: number; bloatRowsInserted: number }> {
  const { db, result } = opts;
  const timestamp = opts.timestamp ?? new Date();

  // `cron_runs` row. `details` carries the structured per-run summary;
  // `metrics` carries the numeric counters the dashboard trends over time.
  const detailsJson = {
    logPath: result.logPath,
    bloatCount: result.bloatFindings.length,
    bloatFindings: result.bloatFindings,
  };
  const metricsJson = {
    pruned: result.pruned,
    freedBytes: result.freedBytes,
    durationMs: result.durationMs,
  };

  const newRow: NewCronRun = {
    timestamp,
    job: "reaper",
    status: result.status,
    details: detailsJson,
    metrics: metricsJson,
  };

  const [inserted] = await db
    .insert(cronRuns)
    .values(newRow)
    .returning({ id: cronRuns.id });

  if (!inserted) {
    throw new Error("cronRuns insert returned no rows");
  }

  let bloatRowsInserted = 0;
  if (result.bloatFindings.length > 0) {
    // bloat_radar.size_bytes / threshold_bytes are Postgres `integer`
    // (≤ 2 GiB). The wrapper rounds anything over the int32 cap down
    // to the cap so the insert never fails — see schema header.
    const INT32_MAX = 2_147_483_647;
    const rows: NewBloatRadar[] = result.bloatFindings.map((f) => ({
      runTimestamp: timestamp,
      label: f.label,
      path: f.path,
      sizeBytes: Math.min(f.sizeBytes, INT32_MAX),
      thresholdBytes: Math.min(f.thresholdBytes, INT32_MAX),
    }));
    await db.insert(bloatRadar).values(rows);
    bloatRowsInserted = rows.length;
  }

  log.info(
    {
      cronRunId: inserted.id,
      bloatRowsInserted,
      status: result.status,
    },
    "reaper: persisted run",
  );

  return { cronRunId: inserted.id, bloatRowsInserted };
}

// ---------------------------------------------------------------------------
// Notification emission
// ---------------------------------------------------------------------------

/**
 * Emit the completion notification(s) for a reaper run via the lifecycle
 * bus. Two emits when findings exist:
 *   1. The general completion notification with `items` (bullet findings)
 *      + `logPath`.
 *   2. A dedicated bloat notification on the `tts` channel for the spoken
 *      warning the chezmoi original surfaced separately.
 */
export function emitReaperNotifications(result: ReaperResult): void {
  const verb =
    result.status === "success"
      ? "complete"
      : result.status === "aborted"
        ? "ABORTED"
        : "FAILED";

  const freedHuman = humanBytes(result.freedBytes);
  const body =
    result.status === "success"
      ? `Weekly cleanup ${verb} — freed ${freedHuman}, pruned ${result.pruned} item(s) in ${Math.round(result.durationMs / 1000)}s.`
      : `Weekly cleanup ${verb} — see ${result.logPath || "log"}.`;

  const items = result.bloatFindings.map(
    (f) => `${f.label}: ${humanBytes(f.sizeBytes)} (path: ${f.path})`,
  );

  lifecycleBus.emit("NotificationFired", {
    id: `reaper-${Date.now()}`,
    title: "Weekly cleanup",
    body,
    channel: "desktop",
    message: body,
    items: items.length > 0 ? items : undefined,
    logPath: result.logPath || undefined,
  });

  // Dedicated TTS for adjacent bloat — the early-warning the disk-fill
  // incident lacked. Spoken separately so it isn't lost in the routine
  // summary.
  if (items.length > 0) {
    const bloatSummary = result.bloatFindings
      .map((f) => `${f.label} ${humanBytes(f.sizeBytes)}`)
      .join("; ");
    lifecycleBus.emit("NotificationFired", {
      id: `reaper-bloat-${Date.now()}`,
      title: "Disk bloat warning",
      body: `Disk bloat warning — ${bloatSummary}. Not auto-cleaned; needs your call.`,
      channel: "tts",
      message: `Disk bloat warning — ${bloatSummary}. Not auto-cleaned; needs your call.`,
      items,
      logPath: result.logPath || undefined,
    });
  }
}

/** Render a byte count as a human-readable string. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

// ---------------------------------------------------------------------------
// Stale-heartbeat detector
// ---------------------------------------------------------------------------

/** Threshold for "stale heartbeat" — > 8 days mirrors the chezmoi original. */
export const STALE_HEARTBEAT_MS = 8 * 24 * 60 * 60 * 1000;

export interface StaleHeartbeatResult {
  stale: boolean;
  reason: "no-prior-success" | "older-than-8d" | "fresh";
  lastSuccessAt: Date | null;
}

/**
 * Query `cron_runs` for the latest `job="reaper" status="success"` row. If
 * the row is absent or older than 8 days, returns `stale: true` so the
 * caller can emit a loud TTS + desktop notification.
 *
 * Exported for unit tests + cron-routes consumption.
 */
export async function checkReaperHeartbeat(
  db: Db,
  now: Date = new Date(),
): Promise<StaleHeartbeatResult> {
  // Use the relational query API for a single most-recent row.
  const row = await db.query.cronRuns.findFirst({
    where: (cr, { and, eq }) =>
      and(eq(cr.job, "reaper"), eq(cr.status, "success")),
    orderBy: (cr, { desc }) => [desc(cr.timestamp)],
  });

  if (!row) {
    return { stale: true, reason: "no-prior-success", lastSuccessAt: null };
  }

  const ageMs = now.getTime() - row.timestamp.getTime();
  if (ageMs > STALE_HEARTBEAT_MS) {
    return { stale: true, reason: "older-than-8d", lastSuccessAt: row.timestamp };
  }

  return { stale: false, reason: "fresh", lastSuccessAt: row.timestamp };
}

/** Emit a loud TTS + desktop notification for a stale heartbeat. */
export function emitStaleHeartbeatNotification(
  result: StaleHeartbeatResult,
): void {
  const lastSeen =
    result.lastSuccessAt !== null
      ? result.lastSuccessAt.toISOString()
      : "never";
  const body =
    result.reason === "no-prior-success"
      ? "Reaper has never succeeded — has the cron service been running?"
      : `Reaper last succeeded ${lastSeen} (>8 days ago) — investigate before the next disk-fill incident.`;

  lifecycleBus.emit("NotificationFired", {
    id: `reaper-stale-${Date.now()}`,
    title: "Reaper stale-heartbeat WARNING",
    body,
    channel: "desktop",
    message: body,
  });

  lifecycleBus.emit("NotificationFired", {
    id: `reaper-stale-tts-${Date.now()}`,
    title: "Reaper stale-heartbeat WARNING",
    body,
    channel: "tts",
    message: body,
  });
}

// ---------------------------------------------------------------------------
// Public orchestration entrypoint
// ---------------------------------------------------------------------------

export interface RunAndPersistOpts extends RunReaperOptions {
  db: Db;
  /** Defaults to `new Date()` — overridable for tests. */
  timestamp?: Date;
  /** Skip lifecycle-bus emit (e.g. during ad-hoc / dry-run smoke tests). */
  suppressNotifications?: boolean;
}

/**
 * High-level entrypoint used by `cron.ts`: spawn the core, persist the
 * result, and emit the notification payload.
 */
export async function runAndPersistReaper(
  opts: RunAndPersistOpts,
): Promise<ReaperResult> {
  const result = await runReaper(opts);

  try {
    await persistReaperResult({
      db: opts.db,
      result,
      timestamp: opts.timestamp,
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      "reaper: persist failed (continuing to notification emit)",
    );
  }

  if (!opts.suppressNotifications) {
    emitReaperNotifications(result);
  }

  return result;
}
