/**
 * context-usage-collector unit tests.
 *
 * Writes throwaway transcript JSONL fixtures to a temp dir and asserts the
 * usedPercentage / contextWindowSize derivation, plus the fail-soft contract
 * (missing file / malformed JSON / no assistant-with-usage line → null, never
 * throw). Fixtures mirror the live CC transcript shape verified 2026-07-17.
 *
 * `collectContextUsage` is now an ASYNC bounded tail-read
 * (async-agent-hot-path-reads / PERF-SYNC-01): it reads only the trailing
 * ~256KB window and falls back to a full read only when no usable line is
 * found inside the window. The window edge-case suite below pins that
 * behavior — small files read whole, a usable line outside the window is still
 * found via fallback, a single line larger than the window is found via
 * fallback, and a truncated final line falls back to the last complete line.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectContextUsage,
  contextWindowForModel,
  DEFAULT_CONTEXT_WINDOW_SIZE,
} from "./context-usage-collector";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-usage-collector-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `lines` (each already a JSON string) as a `.jsonl` fixture, return its path. */
function writeTranscript(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"), "utf-8");
  return path;
}

/** A realistic `assistant` line mirroring the live message.usage shape. */
function assistantLine(usage: Record<string, unknown>, model = "claude-opus-4-8"): string {
  return JSON.stringify({
    type: "assistant",
    message: { model, usage },
  });
}

/** ~256KB tail window; oversize padding is safely > this. */
const OVER_WINDOW_BYTES = 400 * 1024;

describe("collectContextUsage — computation", () => {
  test("sums input + cache_creation + cache_read (excludes output_tokens)", async () => {
    // used = 2 + 718 + 27280 = 28000 → 28000 / 200000 * 100 = 14%
    const path = writeTranscript("compute.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user" } }),
      assistantLine({
        input_tokens: 2,
        cache_creation_input_tokens: 718,
        cache_read_input_tokens: 27280,
        output_tokens: 5000, // must be ignored
      }),
    ]);

    const result = await collectContextUsage(path);
    expect(result).not.toBeNull();
    expect(result!.contextWindowSize).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
    expect(result!.usedPercentage).toBeCloseTo(14, 6);
  });

  test("uses the LAST assistant-with-usage line (backward scan)", async () => {
    const path = writeTranscript("last-line.jsonl", [
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 20000 }), // 10% — stale
      JSON.stringify({ type: "user", message: { role: "user" } }),
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 100000 }), // 50% — newest
    ]);

    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(50, 6);
  });

  test("clamps to 100 when used tokens exceed the window (1M-context session)", async () => {
    // 270072 cache_read alone > 200000 window → clamp to 100.
    const path = writeTranscript("clamp.jsonl", [
      assistantLine({
        input_tokens: 2,
        cache_creation_input_tokens: 718,
        cache_read_input_tokens: 270072,
      }),
    ]);

    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBe(100);
  });

  test("missing usage fields default to 0 (0% for an all-absent usage object)", async () => {
    const path = writeTranscript("empty-usage.jsonl", [
      assistantLine({}),
    ]);

    const result = await collectContextUsage(path);
    expect(result).not.toBeNull();
    expect(result!.usedPercentage).toBe(0);
  });

  test("skips non-assistant lines and trailing blank lines", async () => {
    const path = writeTranscript("mixed.jsonl", [
      JSON.stringify({ type: "system", subtype: "init" }),
      assistantLine({ cache_read_input_tokens: 40000 }), // 20%
      JSON.stringify({ type: "user", message: { role: "user" } }),
      "", // trailing blank line (transcript files often end with \n)
    ]);

    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(20, 6);
  });
});

describe("collectContextUsage — fail-soft (null, never throw)", () => {
  test("missing file → null", async () => {
    expect(await collectContextUsage(join(dir, "does-not-exist.jsonl"))).toBeNull();
  });

  test("malformed JSON line with no valid assistant line → null", async () => {
    const path = writeTranscript("malformed.jsonl", [
      "{ this is not valid json",
      "also broken }}}",
    ]);
    expect(await collectContextUsage(path)).toBeNull();
  });

  test("an assistant line WITHOUT a usage object → null (no usable line)", async () => {
    const path = writeTranscript("no-usage.jsonl", [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8" } }),
    ]);
    expect(await collectContextUsage(path)).toBeNull();
  });

  test("empty file → null", async () => {
    const path = writeTranscript("empty.jsonl", [""]);
    expect(await collectContextUsage(path)).toBeNull();
  });

  test("a valid assistant-with-usage line AFTER a malformed one is still found", async () => {
    // The malformed newest line is skipped; the backward scan continues to the
    // valid one rather than aborting.
    const path = writeTranscript("malformed-then-valid.jsonl", [
      assistantLine({ cache_read_input_tokens: 60000 }), // 30%
      "{ broken json line",
    ]);
    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(30, 6);
  });
});

describe("collectContextUsage — bounded tail-read window", () => {
  test("file smaller than the window reads the whole file (same result as before)", async () => {
    // A tiny file is well under the 256KB window: whole-file path, backward
    // scan finds the last usable line exactly as the old full read did.
    const path = writeTranscript("small.jsonl", [
      assistantLine({ cache_read_input_tokens: 20000 }), // 10% — stale
      assistantLine({ cache_read_input_tokens: 90000 }), // 45% — newest
    ]);
    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(45, 6);
  });

  test("last usable line just INSIDE the window is found in the window read", async () => {
    // Padding first, then the usable line near the very end → the usable line
    // sits inside the trailing window and is found without a fallback read.
    const filler = JSON.stringify({ type: "user", message: { role: "user" } });
    const fillerCount = Math.ceil(OVER_WINDOW_BYTES / (filler.length + 1));
    const lines = Array.from({ length: fillerCount }, () => filler);
    lines.push(assistantLine({ cache_read_input_tokens: 80000 })); // 40% — last line, inside window
    const path = writeTranscript("inside-window.jsonl", lines);
    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(40, 6);
  });

  test("last usable line just OUTSIDE the window is still found via full-read fallback", async () => {
    // The ONLY usable line is at the very start, followed by > window bytes of
    // non-usable filler → the trailing window holds no usable line, so the
    // full-read fallback recovers it.
    const filler = JSON.stringify({ type: "user", message: { role: "user" } });
    const fillerCount = Math.ceil(OVER_WINDOW_BYTES / (filler.length + 1));
    const lines = [assistantLine({ cache_read_input_tokens: 50000 })]; // 25% — outside window
    for (let i = 0; i < fillerCount; i++) lines.push(filler);
    const path = writeTranscript("outside-window.jsonl", lines);
    const result = await collectContextUsage(path);
    expect(result).not.toBeNull();
    expect(result!.usedPercentage).toBeCloseTo(25, 6);
  });

  test("a single usable line LARGER than the window is found via full-read fallback", async () => {
    // One assistant line whose JSON exceeds the window (huge ignored `pad`
    // field). The window read sees only a mid-line fragment (unparseable), so
    // the fallback full read parses the whole line and finds the usage.
    const pad = "x".repeat(OVER_WINDOW_BYTES);
    const bigLine = JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-8", usage: { cache_read_input_tokens: 60000 } },
      pad, // ignored by the parser; only there to blow past the window
    });
    const path = writeTranscript("huge-line.jsonl", [bigLine]);
    const result = await collectContextUsage(path);
    expect(result).not.toBeNull();
    expect(result!.usedPercentage).toBeCloseTo(30, 6);
  });

  test("truncated final line (mid-write) falls back to the last complete usable line", async () => {
    // Simulates a transcript being appended to: the final line is a partial
    // JSON fragment. The backward scan skips it and returns the last complete
    // usable line.
    const path = writeTranscript("truncated-tail.jsonl", [
      assistantLine({ cache_read_input_tokens: 70000 }), // 35% — last complete
      '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"cache_rea', // truncated
    ]);
    const result = await collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(35, 6);
  });

  test("truncated final line with no earlier usable line → null (never throws)", async () => {
    const path = writeTranscript("truncated-only.jsonl", [
      '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"cache_rea', // truncated
    ]);
    expect(await collectContextUsage(path)).toBeNull();
  });
});

describe("contextWindowForModel", () => {
  test("returns the flat default for every model family", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
    expect(contextWindowForModel("claude-sonnet-5")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
    expect(contextWindowForModel("claude-haiku-4-5")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
    expect(contextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
  });
});
