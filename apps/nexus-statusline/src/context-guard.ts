import { statSync } from "node:fs";
import { nowSecs, statePath, readJsonCache, writeJsonAtomic } from "./cache-io";
import { getLocalAgentUrl } from "./project";
import { FETCH_TIMEOUT_MS } from "./usage";
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
  pushContext?: (
    sessionId: string,
    usedPct: number,
    contextWindowSize: number | undefined,
  ) => void;
}

/**
 * PATCH /sessions/:id/context body. Mirrors `sessionContextPatchInput` in
 * `@nexus/core` (packages/core/src/types/session-context.ts) — the agent
 * validates against that schema. Kept inline rather than imported because the
 * statusline's only cross-package wire dependency is
 * `@nexus/statusline-contract`, not `@nexus/core`.
 */
interface SessionContextPush {
  usedPercentage: number;
  contextWindowSize?: number;
}

/**
 * Fire-and-forget PATCH of the RESOLVED (post-guard) context reading to the
 * local nx-agent (`PATCH /sessions/:id/context`). Non-blocking by construction:
 * the async work runs in a discarded (`void`) IIFE with a short
 * AbortController timeout (`FETCH_TIMEOUT_MS`, mirroring `usage.ts`), and EVERY
 * failure — network error, timeout, non-2xx — is swallowed. The statusline
 * render already completed on the locally-resolved value regardless of push
 * outcome. Same-machine call only (localhost/self agent, port 7400).
 */
function defaultPushContext(
  sessionId: string,
  usedPct: number,
  contextWindowSize: number | undefined,
): void {
  const body: SessionContextPush =
    contextWindowSize != null
      ? { usedPercentage: usedPct, contextWindowSize }
      : { usedPercentage: usedPct };
  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      await fetch(
        `${getLocalAgentUrl()}/sessions/${encodeURIComponent(sessionId)}/context`,
        {
          method: "PATCH",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch {
      // fire-and-forget: swallow every failure (network, timeout, non-2xx)
    } finally {
      clearTimeout(timer);
    }
  })();
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
  const pushContext = deps.pushContext ?? defaultPushContext;

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
      // Push the resolved value on every render (independent of the snapshot
      // write-throttle above). Fire-and-forget — never awaited here.
      pushContext(sessionId, usedPct, size);
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
    // Restored fresh snapshot — push the resolved (guarded) value, never the
    // raw spurious-zero CC frame that triggered this branch.
    pushContext(sessionId, snap.used_percentage, snap.context_window_size);
    return { usedPct: snap.used_percentage, contextWindowSize: snap.context_window_size };
  }
  return null;
}
