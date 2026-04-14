/**
 * Integration test: end-to-end tail watcher.
 *
 * Creates a temporary JSONL fixture file with valid transcript lines,
 * feeds them through a TailWatcher, and verifies parsed turns match
 * expected token counts.
 *
 * Uses the shape observed in real CC transcripts:
 * {"timestamp":"...","message":{"model":"...","usage":{...}}}
 *
 * No live database required -- tests the TailWatcher in isolation.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TailWatcher, type ParsedTurn } from "./tail-watcher";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_LINES = [
  JSON.stringify({
    timestamp: "2026-04-14T19:00:00Z",
    message: {
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        service_tier: "standard",
      },
    },
  }),
  JSON.stringify({
    timestamp: "2026-04-14T19:01:00Z",
    message: {
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 200,
        output_tokens: 75,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 50,
        service_tier: "standard",
      },
    },
  }),
  JSON.stringify({
    timestamp: "2026-04-14T19:02:00Z",
    message: {
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 500,
        output_tokens: 150,
        cache_creation_input_tokens: 25,
        cache_read_input_tokens: 100,
        service_tier: "standard",
      },
    },
  }),
];

// Line without usage (should be skipped)
const NON_USAGE_LINE = JSON.stringify({
  timestamp: "2026-04-14T19:00:30Z",
  type: "tool_use",
  message: { model: "claude-sonnet-4-6", content: "hello" },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpBase = path.join("/tmp", `nx-tailwatcher-test-${Date.now()}`);

function createFixture(filename: string, lines: string[]): string {
  mkdirSync(tmpBase, { recursive: true });
  const filePath = path.join(tmpBase, filename);
  writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TailWatcher integration", () => {
  afterEach(() => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("parses 3 valid transcript lines and returns correct token counts", async () => {
    const filePath = createFixture("transcript-3.jsonl", FIXTURE_LINES);

    const collected: ParsedTurn[] = [];
    let finalOffset = 0;

    const watcher = new TailWatcher(filePath, 0, async (turns, newOffset) => {
      collected.push(...turns);
      finalOffset = newOffset;
    });

    await watcher.start();
    // Give a small delay for the initial read to complete
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    expect(collected.length).toBe(3);

    // Turn 1
    expect(collected[0]!.model).toBe("claude-sonnet-4-6");
    expect(collected[0]!.inputTokens).toBe(100);
    expect(collected[0]!.outputTokens).toBe(50);
    expect(collected[0]!.cacheCreationInputTokens).toBe(10);
    expect(collected[0]!.cacheReadInputTokens).toBe(20);
    expect(collected[0]!.serviceTier).toBe("standard");
    expect(collected[0]!.ts.toISOString()).toBe("2026-04-14T19:00:00.000Z");

    // Turn 2
    expect(collected[1]!.model).toBe("claude-sonnet-4-6");
    expect(collected[1]!.inputTokens).toBe(200);
    expect(collected[1]!.outputTokens).toBe(75);

    // Turn 3
    expect(collected[2]!.model).toBe("claude-opus-4-6");
    expect(collected[2]!.inputTokens).toBe(500);
    expect(collected[2]!.outputTokens).toBe(150);
    expect(collected[2]!.cacheCreationInputTokens).toBe(25);
    expect(collected[2]!.cacheReadInputTokens).toBe(100);

    // Byte offset should have advanced past all content
    expect(finalOffset).toBeGreaterThan(0);
  });

  it("skips lines without usage data", async () => {
    const filePath = createFixture("transcript-mixed.jsonl", [
      FIXTURE_LINES[0]!,
      NON_USAGE_LINE,
      FIXTURE_LINES[1]!,
    ]);

    const collected: ParsedTurn[] = [];

    const watcher = new TailWatcher(filePath, 0, async (turns, _offset) => {
      collected.push(...turns);
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Only 2 turns should be parsed (the non-usage line is skipped)
    expect(collected.length).toBe(2);
    expect(collected[0]!.inputTokens).toBe(100);
    expect(collected[1]!.inputTokens).toBe(200);
  });

  it("skips malformed JSON lines gracefully", async () => {
    const filePath = createFixture("transcript-malformed.jsonl", [
      FIXTURE_LINES[0]!,
      "this is not valid json {{{",
      FIXTURE_LINES[2]!,
    ]);

    const collected: ParsedTurn[] = [];

    const watcher = new TailWatcher(filePath, 0, async (turns, _offset) => {
      collected.push(...turns);
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Only 2 valid turns
    expect(collected.length).toBe(2);
  });

  it("respects starting byte offset", async () => {
    const content = FIXTURE_LINES.join("\n") + "\n";
    const filePath = createFixture("transcript-offset.jsonl", FIXTURE_LINES);

    // Calculate offset past the first line
    const firstLineBytes = Buffer.byteLength(FIXTURE_LINES[0]! + "\n", "utf-8");

    const collected: ParsedTurn[] = [];

    const watcher = new TailWatcher(filePath, firstLineBytes, async (turns, _offset) => {
      collected.push(...turns);
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should only see turns 2 and 3 (skipped first line via offset)
    expect(collected.length).toBe(2);
    expect(collected[0]!.inputTokens).toBe(200); // turn 2
    expect(collected[1]!.inputTokens).toBe(500); // turn 3
  });
});
