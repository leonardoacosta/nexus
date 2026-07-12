import { statSync } from "node:fs";
import { statePath, readJsonCache, writeJsonAtomic } from "./cache-io";

const SPEED_WINDOW_MS = 2_000; // samples older than this are stale → reset
const MIN_DELTA_MS = 500; // samples younger than this are too soon → keep, no estimate

/** Per-session speed sample. `timestamp` is milliseconds. */
interface SpeedCache {
  fileSize: number;
  timestamp: number;
}

function isSpeedCache(raw: unknown): raw is SpeedCache {
  const r = raw as { fileSize?: unknown; timestamp?: unknown } | null | undefined;
  return typeof r?.fileSize === "number" && typeof r?.timestamp === "number";
}

/** Injectable seams for `getSpeed` (deterministic in tests). */
interface SpeedDeps {
  statSize?: (path: string) => number | null;
  readCache?: (path: string) => SpeedCache | null;
  writeCache?: (path: string, cache: SpeedCache) => void;
  nowMs?: () => number;
}

function speedCachePath(sessionId: string): string {
  return statePath(`statusline-speed.${sessionId}.json`);
}

function defaultStatSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function defaultReadSpeedCache(path: string): SpeedCache | null {
  return readJsonCache<SpeedCache>(path, isSpeedCache);
}

function defaultWriteSpeedCache(path: string, cache: SpeedCache): void {
  writeJsonAtomic(path, cache);
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
