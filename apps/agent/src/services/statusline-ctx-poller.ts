/**
 * statusline-ctx-poller — persistent poller reading local
 * `~/.claude/scripts/state/statusline-ctx.<sessionId>.json` snapshot files
 * and applying fresh ones directly into the in-process session-context
 * store via `applyStatuslineSnapshot`.
 *
 * Spec: openspec/changes/detach-context-push-from-statusline-lifecycle
 * (task 2.1). Root cause + rationale: design.md § Root cause / § Fix. In
 * short — `nexus-statusline`'s `context-guard.ts` already writes this exact
 * snapshot file synchronously and atomically on every render
 * (`writeJsonAtomic`: `writeFileSync` + `renameSync`, no async gap, cannot
 * be cancelled mid-write). That write already happens reliably. The
 * previously-attempted fire-and-forget network PUSH of the same value from
 * that same short-lived, CC-cancellable process had a ~0% real-world
 * success rate (the process is killed by CC's next statusline trigger
 * before the unawaited fetch completes). This poller sidesteps the race
 * entirely: it lives inside `nx-agent`'s own long-running process (mirrors
 * `process-watcher.ts`'s start/stop lifecycle) and reads the snapshot files
 * directly on a fixed interval instead of waiting for a push that structurally
 * can't survive.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import { applyStatuslineSnapshot, CACHE_TTL_MS } from "../routes/session-context";

const log = createLogger("agent:services:statusline-ctx-poller");

/** Poll cadence — see design.md § Poll cadence and staleness trade-off. */
const DEFAULT_INTERVAL_MS = 3_000;

/**
 * Same state dir `apps/nexus-statusline`'s `cache-io.ts` `STATE_DIR` resolves
 * to (`join(homedir(), ".claude/scripts/state")`). `apps/agent` does not
 * depend on the `@nexus/statusline` package, so the path construction is
 * mirrored here rather than imported — matches the existing convention in
 * this same directory (`statusline-usage-file.ts`'s `usageCachePath()`).
 */
const STATE_DIR = join(homedir(), ".claude", "scripts", "state");

const FILE_PREFIX = "statusline-ctx.";
const FILE_SUFFIX = ".json";

/**
 * Snapshot shape written by `context-guard.ts`'s `writeSnapshot`. `saved_at`
 * is unix seconds (not ms).
 */
interface CtxSnapshot {
  used_percentage: number;
  context_window_size?: number;
  saved_at: number;
}

function isCtxSnapshot(raw: unknown): raw is CtxSnapshot {
  const r = raw as
    | { used_percentage?: unknown; saved_at?: unknown }
    | null
    | undefined;
  return typeof r?.used_percentage === "number" && typeof r?.saved_at === "number";
}

/**
 * Extract the session id from a `statusline-ctx.<id>.json` filename — the
 * part between the fixed prefix/suffix. Returns `null` for any filename that
 * doesn't match (other cache files may share the same directory).
 */
function extractSessionId(fileName: string): string | null {
  if (!fileName.startsWith(FILE_PREFIX) || !fileName.endsWith(FILE_SUFFIX)) {
    return null;
  }
  const id = fileName.slice(FILE_PREFIX.length, fileName.length - FILE_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Read + parse one snapshot file. Fail-soft: missing / unreadable /
 * unparseable / shape-invalid all resolve to `null`, never throw — matches
 * `cache-io.ts`'s `readJsonCache` convention this mirrors.
 */
function readSnapshotFile(path: string): CtxSnapshot | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isCtxSnapshot(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * One poll tick: list every `statusline-ctx.*.json` file in the state dir,
 * parse each, skip stale (older than the shared `CACHE_TTL_MS` freshness
 * window) or malformed/unreadable entries, and apply the rest via
 * `applyStatuslineSnapshot`. Returns the number of entries applied (test/
 * debug visibility only — callers don't need it). Never throws: a missing
 * state dir, an unreadable file, or a malformed snapshot is skipped
 * silently, matching this codebase's universal file-cache-read convention.
 */
export function pollOnce(): number {
  let entries: string[];
  try {
    entries = readdirSync(STATE_DIR);
  } catch {
    // State dir missing/unreadable — nothing to poll this tick.
    return 0;
  }

  const freshWindowSecs = CACHE_TTL_MS / 1_000;
  const nowSecs = Math.floor(Date.now() / 1000);
  let applied = 0;

  for (const fileName of entries) {
    const sessionId = extractSessionId(fileName);
    if (!sessionId) continue;

    const snap = readSnapshotFile(join(STATE_DIR, fileName));
    if (!snap) continue;
    if (nowSecs - snap.saved_at >= freshWindowSecs) continue;

    try {
      applyStatuslineSnapshot(
        sessionId,
        snap.used_percentage,
        snap.context_window_size ?? null,
      );
      applied += 1;
    } catch (err) {
      log.warn(
        { sessionId, error: err instanceof Error ? err.message : String(err) },
        "applyStatuslineSnapshot failed for statusline-ctx snapshot (non-fatal)",
      );
    }
  }

  return applied;
}

export interface StatuslineCtxPollerHandle {
  /** Stop the interval loop. Safe to call multiple times. */
  stop(): void;
}

/**
 * Start a fixed-interval poller (default 3s) that reads local
 * `statusline-ctx.*.json` snapshot files into the in-process
 * session-context store. Mirrors `process-watcher.ts`'s
 * `startProcessWatcher` lifecycle: the first pass fires immediately,
 * subsequent ticks self-schedule via `setTimeout` (not `setInterval`, so an
 * overlapping tick can't stack), and `stop()` halts the loop.
 */
export function startStatuslineCtxPoller(opts?: {
  intervalMs?: number;
}): StatuslineCtxPollerHandle {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const tick = () => {
    if (stopped) return;
    if (running) {
      // Skip overlapping tick — keep cadence honest.
      timer = setTimeout(tick, intervalMs);
      return;
    }
    running = true;
    try {
      pollOnce();
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "pollOnce threw",
      );
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
      }
    }
  };

  // Fire immediately; the next tick is scheduled inside `tick`.
  tick();

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
  extractSessionId,
  readSnapshotFile,
  pollOnce,
  STATE_DIR,
};
