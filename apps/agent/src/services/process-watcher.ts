/**
 * Process watcher — keeps the `sessions` table in sync with the set of live
 * `claude` processes on this machine.
 *
 * On a 30-second interval (configurable) the watcher:
 *   1. Runs `pgrep -af claude` and parses the (pid, cmd) pairs.
 *   2. Filters down to genuine `claude` binaries — helper procs (mcp, zsh
 *      wrappers, etc.) are excluded.
 *   3. Loads all open session rows (`status = 'active' AND ended_at IS
 *      NULL`) that the watcher already tagged with a PID. For each one
 *      whose PID has disappeared, sets `endedAt = NOW()`, `status =
 *      "ended"` and emits a `RemoteSessionEnded` lifecycle event.
 *   4. For every live PID that has no matching row, INSERTS a new
 *      fingerprinted row (`pid`, `model = "claude"`, optional `cwd` from
 *      `/proc/<pid>/cwd` on Linux) and emits a `RemoteSessionStarted`.
 *
 * Legacy rows whose `pid` is null are NEVER closed by this watcher — those
 * predate the tracking work and may have been created by hooks. The
 * one-shot cleanup migration (task 1.1) already retired the dead ones.
 *
 * See: fix-agent-cc-session-tracking § Scenario "Process watcher
 * reconciles dead PIDs" / "detects new claude processes".
 */

import { randomUUID } from "node:crypto";
import { readlinkSync } from "node:fs";
import type { Db } from "@nexus/db";
import { sessions, eq } from "@nexus/db";
import { and, isNull, isNotNull, gt } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { execText } from "../utils/exec";
import { upsertSession, touchHeartbeatByPids } from "../db/sessions";
import { lifecycleBus } from "./lifecycle-bus";

const log = createLogger("agent:process-watcher");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30_000;

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
 */
async function listClaudeProcesses(): Promise<LiveProcess[]> {
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
      "pgrep failed; skipping reconciliation pass",
    );
    return [];
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

/**
 * Best-effort cwd lookup. `/proc/<pid>/cwd` is a symlink on Linux; macOS
 * has no `/proc` so we return `undefined` and let the caller skip the
 * field.
 */
function readProcessCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

export interface ReconcileResult {
  /** Number of rows newly INSERTED by this pass. */
  created: number;
  /** Number of rows transitioned to `status = 'ended'` by this pass. */
  closed: number;
}

/**
 * Single reconciliation pass. Exposed standalone so the
 * `POST /sessions/probe` route handler can trigger it on demand.
 */
export async function reconcileOnce(db: Db): Promise<ReconcileResult> {
  const live = await listClaudeProcesses();
  const livePids = new Set(live.map((p) => p.pid));

  // Step 1: select open rows the watcher already manages (pid IS NOT NULL,
  // pid > 0). Rows lacking a pid are legacy and left alone — they MAY be
  // managed by hook-driven session_start payloads which carry their own
  // tmux/cc identifiers but no PID.
  const openRows = await db
    .select({ id: sessions.id, pid: sessions.pid })
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
  let closed = 0;
  const now = new Date();

  for (const row of openRows) {
    const pid = row.pid;
    if (pid === null || pid <= 0) continue;
    managedPids.add(pid);
    if (livePids.has(pid)) {
      liveManagedPids.push(pid);
    }
    if (!livePids.has(pid)) {
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

  // Step 1b: refresh last_activity for live, already-managed PIDs (single
  // batched UPDATE). Process-aliveness is a valid liveness signal even when
  // no CC hook fired this interval.
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

  // Step 2: open rows for live PIDs we haven't seen yet.
  let created = 0;
  for (const proc of live) {
    if (managedPids.has(proc.pid)) continue;
    const cwd = readProcessCwd(proc.pid);
    const sessionId = `cc-${proc.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await upsertSession(db, {
        id: sessionId,
        pid: proc.pid,
        project: undefined,
        projectId: null,
        machine: "local",
        cwd: cwd ?? "",
        branch: null,
        startedAt: now,
        lastHeartbeat: now,
        endedAt: null,
        status: "active",
        spec: null,
        command: null,
        agent: null,
        tmuxSession: null,
        ccSessionId: null,
        tmuxTarget: null,
        rateLimitUtilization: null,
        rateLimitType: null,
        totalCostUsd: null,
        model: "claude",
        credentialId: null,
        credentialFingerprint: null,
        sessionType: "managed",
        parentSessionId: null,
        childRole: null,
      });
      created += 1;
      lifecycleBus.emit("RemoteSessionStarted", {
        sessionId,
        pid: proc.pid,
        cwd: cwd ?? null,
        model: "claude",
        tmuxTarget: null,
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
    log.info({ created, closed, live: live.length }, "reconciliation pass complete");
  }

  return { created, closed };
}

export interface ProcessWatcherHandle {
  /** Stop the interval loop. Safe to call multiple times. */
  stop(): void;
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
  };
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __testing = {
  isClaudeCommand,
  listClaudeProcesses,
  readProcessCwd,
};
