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

import { readFileSync } from "node:fs";

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
 * `readFileSync` reads the whole file: transcripts are line-delimited JSON and
 * we only need the last usage-bearing line, so a full read + backward scan is
 * simple and sufficient at this call frequency (once per hook event, not a
 * standalone poll loop).
 */
export function collectContextUsage(
  transcriptPath: string,
): ContextUsageResult | null {
  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

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
