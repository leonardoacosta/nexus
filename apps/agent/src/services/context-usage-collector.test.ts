/**
 * context-usage-collector unit tests.
 *
 * Writes throwaway transcript JSONL fixtures to a temp dir and asserts the
 * usedPercentage / contextWindowSize derivation, plus the fail-soft contract
 * (missing file / malformed JSON / no assistant-with-usage line → null, never
 * throw). Fixtures mirror the live CC transcript shape verified 2026-07-17.
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

describe("collectContextUsage — computation", () => {
  test("sums input + cache_creation + cache_read (excludes output_tokens)", () => {
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

    const result = collectContextUsage(path);
    expect(result).not.toBeNull();
    expect(result!.contextWindowSize).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
    expect(result!.usedPercentage).toBeCloseTo(14, 6);
  });

  test("uses the LAST assistant-with-usage line (backward scan)", () => {
    const path = writeTranscript("last-line.jsonl", [
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 20000 }), // 10% — stale
      JSON.stringify({ type: "user", message: { role: "user" } }),
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 100000 }), // 50% — newest
    ]);

    const result = collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(50, 6);
  });

  test("clamps to 100 when used tokens exceed the window (1M-context session)", () => {
    // 270072 cache_read alone > 200000 window → clamp to 100.
    const path = writeTranscript("clamp.jsonl", [
      assistantLine({
        input_tokens: 2,
        cache_creation_input_tokens: 718,
        cache_read_input_tokens: 270072,
      }),
    ]);

    const result = collectContextUsage(path);
    expect(result!.usedPercentage).toBe(100);
  });

  test("missing usage fields default to 0 (0% for an all-absent usage object)", () => {
    const path = writeTranscript("empty-usage.jsonl", [
      assistantLine({}),
    ]);

    const result = collectContextUsage(path);
    expect(result).not.toBeNull();
    expect(result!.usedPercentage).toBe(0);
  });

  test("skips non-assistant lines and trailing blank lines", () => {
    const path = writeTranscript("mixed.jsonl", [
      JSON.stringify({ type: "system", subtype: "init" }),
      assistantLine({ cache_read_input_tokens: 40000 }), // 20%
      JSON.stringify({ type: "user", message: { role: "user" } }),
      "", // trailing blank line (transcript files often end with \n)
    ]);

    const result = collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(20, 6);
  });
});

describe("collectContextUsage — fail-soft (null, never throw)", () => {
  test("missing file → null", () => {
    expect(collectContextUsage(join(dir, "does-not-exist.jsonl"))).toBeNull();
  });

  test("malformed JSON line with no valid assistant line → null", () => {
    const path = writeTranscript("malformed.jsonl", [
      "{ this is not valid json",
      "also broken }}}",
    ]);
    expect(collectContextUsage(path)).toBeNull();
  });

  test("an assistant line WITHOUT a usage object → null (no usable line)", () => {
    const path = writeTranscript("no-usage.jsonl", [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8" } }),
    ]);
    expect(collectContextUsage(path)).toBeNull();
  });

  test("empty file → null", () => {
    const path = writeTranscript("empty.jsonl", [""]);
    expect(collectContextUsage(path)).toBeNull();
  });

  test("a valid assistant-with-usage line AFTER a malformed one is still found", () => {
    // The malformed newest line is skipped; the backward scan continues to the
    // valid one rather than aborting.
    const path = writeTranscript("malformed-then-valid.jsonl", [
      assistantLine({ cache_read_input_tokens: 60000 }), // 30%
      "{ broken json line",
    ]);
    const result = collectContextUsage(path);
    expect(result!.usedPercentage).toBeCloseTo(30, 6);
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
