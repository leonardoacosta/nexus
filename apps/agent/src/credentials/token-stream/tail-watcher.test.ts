/**
 * Unit tests for `TailWatcher` api-error detection (add-api-error-notification,
 * nx-t2r5z). The watcher tails a real JSONL file on disk; we drive it through
 * its public surface (constructor + `start()`) rather than poking the private
 * `parseLine`/`parseApiError` methods. Each test writes a transcript fixture to
 * a temp file, runs an initial read, and asserts which callback fired.
 *
 * Two invariants under test:
 *   1. api-error lines (`isApiErrorMessage: true` or `^API Error:` content)
 *      invoke `onApiError(text)`.
 *   2. usage-bearing lines STILL parse as token turns via `onTurns` — the
 *      api-error detection branch must not regress usage extraction.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TailWatcher, type ParsedTurn } from "./tail-watcher";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-tail-watcher-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a JSONL transcript fixture and return its absolute path. */
function writeTranscript(name: string, objs: unknown[]): string {
  const path = join(dir, name);
  const lines = objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  writeFileSync(path, lines);
  return path;
}

/**
 * Run a single initial read of `path` and collect everything both callbacks
 * received. Returns the captured turns + api-error texts. We `start()` then
 * immediately `stop()` so the fs.watch subscription does not leak between tests.
 */
async function readOnce(path: string): Promise<{
  turns: ParsedTurn[];
  apiErrors: string[];
}> {
  const turns: ParsedTurn[] = [];
  const apiErrors: string[] = [];

  const watcher = new TailWatcher(
    path,
    0,
    async (batch) => {
      turns.push(...batch);
    },
    async (text) => {
      apiErrors.push(text);
    },
  );

  await watcher.start();
  watcher.stop();

  return { turns, apiErrors };
}

// A canonical usage-bearing assistant turn (mirrors a real CC transcript line).
const usageLine = {
  type: "assistant",
  timestamp: "2026-06-19T12:00:00.000Z",
  message: {
    model: "claude-opus-4",
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 8000,
      service_tier: "standard",
    },
  },
};

describe("TailWatcher api-error detection (nx-t2r5z)", () => {
  it("invokes onApiError for an isApiErrorMessage:true line", async () => {
    const path = writeTranscript("flagged.jsonl", [
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: "API Error: 529 {\"type\":\"overloaded_error\"}" },
      },
    ]);

    const { turns, apiErrors } = await readOnce(path);

    expect(apiErrors).toHaveLength(1);
    expect(apiErrors[0]).toContain("529");
    // An api-error line carries no usage block — it must NOT count as a turn.
    expect(turns).toHaveLength(0);
  });

  it("invokes onApiError for a `^API Error:` content line without the flag", async () => {
    const path = writeTranscript("prefixed.jsonl", [
      { type: "assistant", content: "API Error: 503 Service Unavailable" },
    ]);

    const { turns, apiErrors } = await readOnce(path);

    expect(apiErrors).toHaveLength(1);
    expect(apiErrors[0]).toBe("API Error: 503 Service Unavailable");
    expect(turns).toHaveLength(0);
  });

  it("detects the flag nested under message.content as an array of text blocks", async () => {
    const path = writeTranscript("array-content.jsonl", [
      {
        type: "assistant",
        message: {
          isApiErrorMessage: true,
          content: [{ type: "text", text: "API Error: 429 rate_limit_error" }],
        },
      },
    ]);

    const { apiErrors } = await readOnce(path);

    expect(apiErrors).toHaveLength(1);
    expect(apiErrors[0]).toContain("429");
  });

  it("does NOT regress usage extraction — a usage line still parses as a turn", async () => {
    const path = writeTranscript("usage-only.jsonl", [usageLine]);

    const { turns, apiErrors } = await readOnce(path);

    // The usage-bearing line is a token turn; the api-error branch leaves it
    // untouched and fires no api-error callback.
    expect(apiErrors).toHaveLength(0);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.inputTokens).toBe(1200);
    expect(turns[0]!.outputTokens).toBe(340);
    expect(turns[0]!.cacheReadInputTokens).toBe(8000);
    expect(turns[0]!.model).toBe("claude-opus-4");
    expect(turns[0]!.serviceTier).toBe("standard");
  });

  it("separates turns from api-errors in a mixed transcript", async () => {
    // A realistic burst: a normal turn, then an api-error, then recovery turn.
    const path = writeTranscript("mixed.jsonl", [
      usageLine,
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: "API Error: 529 Overloaded" },
      },
      {
        ...usageLine,
        message: {
          ...usageLine.message,
          usage: { ...usageLine.message.usage, input_tokens: 50, output_tokens: 10 },
        },
      },
    ]);

    const { turns, apiErrors } = await readOnce(path);

    // Two usage turns extracted, one api-error detected — the branches do not
    // steal lines from each other.
    expect(turns).toHaveLength(2);
    expect(apiErrors).toHaveLength(1);
    expect(apiErrors[0]).toContain("Overloaded");
  });

  it("ignores ordinary non-usage, non-api lines (neither callback fires)", async () => {
    const path = writeTranscript("benign.jsonl", [
      { type: "user", message: { content: "hello" } },
      { type: "system", subtype: "init" },
    ]);

    const { turns, apiErrors } = await readOnce(path);

    expect(turns).toHaveLength(0);
    expect(apiErrors).toHaveLength(0);
  });

  it("no-ops api-error detection when onApiError is omitted (token-only watcher)", async () => {
    // Omitting the callback must not throw and must not affect usage extraction.
    const path = writeTranscript("no-callback.jsonl", [
      usageLine,
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: "API Error: 529 Overloaded" },
      },
    ]);

    const turns: ParsedTurn[] = [];
    const watcher = new TailWatcher(path, 0, async (batch) => {
      turns.push(...batch);
    });
    // No onApiError supplied.
    await watcher.start();
    watcher.stop();

    expect(turns).toHaveLength(1);
  });
});
