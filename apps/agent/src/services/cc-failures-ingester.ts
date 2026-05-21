/**
 * cc-failures-ingester — reads CC tool-failure JSONL files from
 * `~/.claude/scripts/state/failures/YYYY-MM-DD.jsonl` and yields normalized
 * entries.
 *
 * Spec: openspec/changes/failures-investigation-and-surface
 *
 * The JSONL files are written by the CC hooks layer. Schema in the wild:
 *
 *   { "time": <ms-epoch>, "tool": "Bash", "error": "<snippet>",
 *     "command": "<snippet>", "project": "leonardoacosta", "session_id": "..." }
 *
 * The proposal text uses an alternate shape with `timestamp`, `tool_name`,
 * `error_snippet`, `command_snippet`. This ingester normalizes BOTH shapes
 * — production rows use the short keys; future writers may use the long
 * keys; either works.
 *
 * Streaming: `Bun.file().stream()` yields a `ReadableStream<Uint8Array>`;
 * we decode incrementally so multi-MB files don't land in memory whole.
 *
 * Cache: 60-second TTL keyed by `days` argument. Lookup-first; misses
 * trigger a fresh read.
 *
 * Errors: `JSON.parse` failures per line increment `parseErrors` and are
 * NEVER rethrown — malformed legacy lines must not crash the endpoint.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureEntry {
  /** Epoch milliseconds (normalized from `time` or `timestamp`). */
  timestamp: number;
  /** Tool name (e.g. "Read", "Bash"). */
  toolName: string;
  /** Error snippet — the raw error text (already truncated upstream). */
  errorSnippet: string;
  /** Command snippet — the failing command/input. */
  commandSnippet: string;
  /** Project slug (e.g. "nx"). */
  project: string;
  /** Optional session id. */
  sessionId: string | null;
}

export interface IngestResult {
  entries: FailureEntry[];
  parseErrors: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root directory containing per-day JSONL failure files. */
export const DEFAULT_FAILURES_DIR = join(
  homedir(),
  ".claude",
  "scripts",
  "state",
  "failures",
);

// Allow tests to override the source dir without touching the user's
// real ~/.claude. Setting this resets the cache as well.
let _failuresDir: string = DEFAULT_FAILURES_DIR;

export function setFailuresDir(dir: string): void {
  _failuresDir = dir;
  clearFailuresCache();
}

export function getFailuresDir(): string {
  return _failuresDir;
}

export function resetFailuresDir(): void {
  _failuresDir = DEFAULT_FAILURES_DIR;
  clearFailuresCache();
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: IngestResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const _cache: Map<number, CacheEntry> = new Map();

/** Clear the ingester cache (test seam + admin reset). */
export function clearFailuresCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface RawLine {
  // Real production schema:
  time?: number;
  tool?: string;
  error?: string;
  command?: string;
  // Spec-text schema:
  timestamp?: number | string;
  tool_name?: string;
  error_snippet?: string;
  command_snippet?: string;
  // Shared:
  project?: string;
  session_id?: string | null;
}

function normalizeRaw(raw: RawLine): FailureEntry | null {
  const ts =
    typeof raw.time === "number"
      ? raw.time
      : typeof raw.timestamp === "number"
        ? raw.timestamp
        : typeof raw.timestamp === "string"
          ? Date.parse(raw.timestamp)
          : NaN;
  if (!Number.isFinite(ts)) return null;

  const toolName =
    (typeof raw.tool === "string" && raw.tool) ||
    (typeof raw.tool_name === "string" && raw.tool_name) ||
    "";
  if (!toolName) return null;

  const errorSnippet =
    (typeof raw.error === "string" && raw.error) ||
    (typeof raw.error_snippet === "string" && raw.error_snippet) ||
    "";

  const commandSnippet =
    (typeof raw.command === "string" && raw.command) ||
    (typeof raw.command_snippet === "string" && raw.command_snippet) ||
    "";

  const project = typeof raw.project === "string" ? raw.project : "";
  const sessionId =
    typeof raw.session_id === "string" ? raw.session_id : null;

  return {
    timestamp: ts,
    toolName,
    errorSnippet,
    commandSnippet,
    project,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

/** Match `YYYY-MM-DD.jsonl` filenames. */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * List candidate files whose date is in `[now - 2*days, now]` (we read up
 * to the previous window because the trend computation needs it). Returns
 * absolute paths sorted ascending by date.
 */
async function listCandidateFiles(days: number, now: number): Promise<string[]> {
  if (!existsSync(_failuresDir)) return [];
  let names: string[];
  try {
    names = await readdir(_failuresDir);
  } catch {
    return [];
  }
  // Trend needs current + previous window — read 2*days back.
  const cutoffMs = now - 2 * days * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  const matched: string[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    if (m[1]! < cutoffDay) continue;
    matched.push(join(_failuresDir, name));
  }
  matched.sort();
  return matched;
}

// ---------------------------------------------------------------------------
// Streaming parser
// ---------------------------------------------------------------------------

/**
 * Stream one JSONL file line-by-line. Per-line parse failures bump the
 * `parseErrors` counter; nothing throws to the caller.
 */
async function ingestFile(
  filePath: string,
  out: FailureEntry[],
  counters: { parseErrors: number },
): Promise<void> {
  // Bun.file() is the streaming primitive. node fs.createReadStream also
  // works but Bun.file is the project convention.
  const file = Bun.file(filePath);
  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      processLine(line, out, counters);
      nl = buf.indexOf("\n");
    }
  }
  // Flush trailing line (no terminating newline).
  buf += decoder.decode();
  if (buf.length > 0) {
    processLine(buf, out, counters);
  }
}

function processLine(
  rawLine: string,
  out: FailureEntry[],
  counters: { parseErrors: number },
): void {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  let parsed: RawLine;
  try {
    parsed = JSON.parse(trimmed) as RawLine;
  } catch {
    counters.parseErrors += 1;
    return;
  }
  const entry = normalizeRaw(parsed);
  if (!entry) {
    // Malformed shape (missing required fields) — count as parse error.
    counters.parseErrors += 1;
    return;
  }
  out.push(entry);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest failures for the requested day window. Streams JSONL files
 * line-by-line; tolerant of malformed lines.
 *
 * The returned `entries` are NOT filtered to the requested window — the
 * caller (failures-route) decides current-vs-previous slicing for trend
 * computation. The result is bounded to `[now - 2*days, now]` of files
 * for cache locality.
 */
export async function ingestFailures(days: number): Promise<IngestResult> {
  // Cache lookup-first.
  const cached = _cache.get(days);
  const nowMs = Date.now();
  if (cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const files = await listCandidateFiles(days, nowMs);
  const entries: FailureEntry[] = [];
  const counters = { parseErrors: 0 };
  for (const f of files) {
    try {
      await ingestFile(f, entries, counters);
    } catch {
      // A single file failure must not abort the whole window.
      counters.parseErrors += 1;
    }
  }
  const value: IngestResult = { entries, parseErrors: counters.parseErrors };
  _cache.set(days, { value, expiresAt: nowMs + CACHE_TTL_MS });
  return value;
}
