import { statSync } from "node:fs";
import { nowSecs, statePath, readJsonCache, writeJsonAtomic } from "./cache-io";
import type { CcInput, ResolvedContext } from "./types";

const CTX_FRESH_WINDOW_SECS = 600; // 10-min last-good snapshot freshness window
const CTX_WRITE_THROTTLE_MS = 3_000; // skip a snapshot rewrite when the file is <3s old

/** Per-session last-good context snapshot. `saved_at` is unix seconds. */
interface CtxSnapshot {
  used_percentage: number;
  context_window_size?: number;
  saved_at: number;
}

function isCtxSnapshot(raw: unknown): raw is CtxSnapshot {
  const r = raw as { used_percentage?: unknown; saved_at?: unknown } | null | undefined;
  return typeof r?.used_percentage === "number" && typeof r?.saved_at === "number";
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
  return statePath(`statusline-ctx.${sessionId}.json`);
}

function defaultReadSnapshot(path: string): CtxSnapshot | null {
  return readJsonCache<CtxSnapshot>(path, isCtxSnapshot);
}

function defaultWriteSnapshot(path: string, snap: CtxSnapshot): void {
  writeJsonAtomic(path, snap);
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
