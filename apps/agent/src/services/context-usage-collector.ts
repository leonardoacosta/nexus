/**
 * context-usage-collector — derive a session's context-window usage percentage
 * from its transcript JSONL, event-driven off the hook stream nx already
 * ingests.
 *
 * Why this exists: CC removed its `statusLine` hook command (cc commit
 * 2a6eda0c, 2026-07-16). That command was the ONLY source nx ever had for a
 * session's context-window %; `nexus-statusline`'s `context-guard.ts` no longer
 * receives it, so the snapshot files `statusline-ctx-poller.ts` reads never get
 * written and `GET /sessions/:id/context` has been permanently empty since then.
 *
 * The replacement (design decided by Leo): compute the usage agent-side off the
 * hook events nx already receives over its socket. Every CC hook payload carries
 * a `transcript_path`; this pure helper reads that transcript and reproduces
 * (approximately) what CC's removed statusLine command computed. It does NOT
 * poll transcripts on its own cadence — `process-hook-event.ts` calls it only
 * when a live hook event arrives carrying a `transcript_path`, keeping it
 * consistent with nx's standing architectural note against transcript-polling
 * HUDs.
 *
 * Fail-soft convention (mirrors `statusline-ctx-poller.ts`'s `readSnapshotFile`):
 * missing / unreadable / malformed / no-usable-line all resolve to `null`,
 * never throw.
 */

import { open } from "node:fs/promises";

/**
 * Flat context-window size assumed for every known Claude model family
 * (Opus / Sonnet / Haiku). This is an APPROXIMATION: real context windows vary
 * (200K standard, 1M-context beta), and no per-model lookup table or 1M-context
 * convention exists elsewhere in this repo (grep confirmed). The percentage is
 * clamped to `[0, 100]`, so a 1M-context session whose used tokens exceed 200K
 * simply reads as 100% rather than overflowing — an accepted approximation, not
 * a byte-exact replica of CC's removed statusLine computation.
 */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;

/**
 * Look up the context-window size for a model. Today this is a flat default for
 * every model family (see `DEFAULT_CONTEXT_WINDOW_SIZE`); the parameter is kept
 * so a real per-model table can slot in later without touching call sites.
 */
export function contextWindowForModel(_model: string | undefined): number {
  return DEFAULT_CONTEXT_WINDOW_SIZE;
}

/**
 * The `message.usage` subset we read. Field names mirror the live CC transcript
 * shape (verified 2026-07-17):
 * `{ input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *    output_tokens, ... }`.
 */
interface TranscriptUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** One transcript JSONL line, narrowed to the fields we inspect. */
interface TranscriptLine {
  type?: string;
  message?: {
    model?: string;
    usage?: TranscriptUsage;
  };
}

export interface ContextUsageResult {
  usedPercentage: number;
  contextWindowSize: number;
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Trailing byte window read from the transcript tail. Transcripts grow to
 * 6-9MB routinely (20MB+ observed); the last usage-bearing line is always near
 * the end, so reading the whole file just to scan its tail is pure waste on
 * every hook event. 256KB comfortably spans many transcript lines (the biggest
 * realistic single line — a large tool_result — is still well under this), so
 * the last `assistant`-with-`usage` line is essentially always inside it.
 */
const TAIL_WINDOW_BYTES = 256 * 1024;

/**
 * Backward-scan already-read `content` for the LAST `assistant` line carrying a
 * `message.usage` object, and compute the usage result from it. Truncated /
 * non-JSON lines (e.g. the partial leading line of a tail window, or a line
 * still being written) are skipped, not fatal. Returns `null` when no usable
 * line is present. Pure — no IO.
 */
function scanForLastUsage(content: string): ContextUsageResult | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (!raw) continue;

    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue; // a truncated / non-JSON line is skipped, not fatal
    }

    if (parsed?.type !== "assistant") continue;
    const usage = parsed.message?.usage;
    if (!usage || typeof usage !== "object") continue;

    const usedTokens =
      numOr0(usage.input_tokens) +
      numOr0(usage.cache_creation_input_tokens) +
      numOr0(usage.cache_read_input_tokens);

    const contextWindowSize = contextWindowForModel(parsed.message?.model);
    const pct = (usedTokens / contextWindowSize) * 100;
    const usedPercentage = Math.max(0, Math.min(100, pct));

    return { usedPercentage, contextWindowSize };
  }

  return null;
}

/**
 * Read the transcript at `transcriptPath` and compute the current
 * context-window usage from the LAST `assistant` line that carries a
 * `message.usage` object.
 *
 * `usedTokens = input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens` — the tokens sent TO the model on the most recent
 * turn, which already includes prior history via caching. `output_tokens` is
 * deliberately excluded: it is generation for the NEXT turn, not part of the
 * current context. This approximates (not byte-exactly replicates) what CC's
 * removed statusLine command reported.
 *
 * Returns `{ usedPercentage, contextWindowSize }` (percentage clamped to
 * `[0, 100]`), or `null` when the file is missing / unreadable / malformed or
 * contains no assistant-with-usage line. Never throws.
 *
 * ASYNC BOUNDED TAIL-READ (async-agent-hot-path-reads / PERF-SYNC-01): this
 * runs once per `tool_use_end`/`user_prompt` socket event on the agent's
 * SINGLE event loop (process-hook-event.ts). A synchronous whole-file read of a
 * multi-MB, still-growing transcript blocked that loop and allocated
 * O(file-size) per event. We now `fstat` the file and read only the trailing
 * `TAIL_WINDOW_BYTES` via `node:fs/promises`, backward-scanning that window for
 * the last usable line. Only when the window holds NO usable line (e.g. a
 * single line larger than the window) do we fall back to reading from the start
 * of the file — the same full read as before, capped at the real file size.
 *
 * Convention note (PERF-SYNC audit, `docs/audit/false-positives.md`): reads on
 * a recurring, request/ingest-path hot loop over a growing file — like this one
 * — MUST be async. Deliberately sync sites are OUT of that class and left
 * untouched: one-shot startup reads, bounded pollers, `state-snapshot.ts`'s
 * atomic tmp+rename flush, the `nexus-emit` CLI, and `memory-pressure.ts`
 * procfs reads. Sync-vs-async here is about "recurring hot read on a file that
 * grows", not about the fs API being nicer.
 */
export async function collectContextUsage(
  transcriptPath: string,
): Promise<ContextUsageResult | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(transcriptPath, "r");
    const { size } = await fh.stat();

    if (size <= TAIL_WINDOW_BYTES) {
      // File fits in the window — read the whole thing (byte-identical to the
      // old full read for small transcripts).
      const content = await fh.readFile("utf-8");
      return scanForLastUsage(content);
    }

    // Read only the trailing window. Its first line is likely a partial
    // fragment; `scanForLastUsage` skips it as unparseable.
    const start = size - TAIL_WINDOW_BYTES;
    const buffer = Buffer.allocUnsafe(TAIL_WINDOW_BYTES);
    const { bytesRead } = await fh.read(buffer, 0, TAIL_WINDOW_BYTES, start);
    const windowResult = scanForLastUsage(
      buffer.toString("utf-8", 0, bytesRead),
    );
    if (windowResult) return windowResult;

    // No usable line inside the window (e.g. one line exceeds the window).
    // Fall back to the full read from the start of the file, as before.
    const full = await fh.readFile("utf-8");
    return scanForLastUsage(full);
  } catch {
    return null;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* close failure is non-fatal */
      }
    }
  }
}
