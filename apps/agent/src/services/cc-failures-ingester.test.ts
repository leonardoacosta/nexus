/**
 * Tests for `cc-failures-ingester`.
 *
 * Project convention (rules/PATTERNS.md): use real tmpdir JSONL fixtures
 * instead of mocking fs / Bun.file. The ingester is a thin streaming
 * adapter — mocking it would test the mocks, not the parser.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ingestFailures,
  clearFailuresCache,
  setFailuresDir,
  resetFailuresDir,
} from "./cc-failures-ingester";

let dir: string;

function isoDay(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function tsDaysAgo(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 60 * 60 * 1000;
}

function writeJsonl(name: string, lines: string[]): void {
  writeFileSync(join(dir, name), lines.join("\n") + "\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-failures-ingester-"));
  setFailuresDir(dir);
  clearFailuresCache();
});

afterEach(() => {
  resetFailuresDir();
  clearFailuresCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestFailures", () => {
  test("empty filesystem returns zero entries, zero parse errors", async () => {
    // Use an empty subdir to simulate missing/empty failures dir.
    const empty = mkdtempSync(join(tmpdir(), "nexus-failures-empty-"));
    setFailuresDir(empty);
    const result = await ingestFailures(7);
    expect(result.entries).toEqual([]);
    expect(result.parseErrors).toBe(0);
    rmSync(empty, { recursive: true, force: true });
  });

  test("missing directory does not throw", async () => {
    const ghost = join(tmpdir(), "nexus-failures-doesnotexist-" + Date.now());
    setFailuresDir(ghost);
    const result = await ingestFailures(7);
    expect(result.entries).toEqual([]);
    expect(result.parseErrors).toBe(0);
  });

  test("single-day populated file parses all lines", async () => {
    const day = isoDay(0);
    const t = tsDaysAgo(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({
        time: t,
        tool: "Read",
        error: "ENOENT",
        command: "cat foo",
        project: "nx",
        session_id: "s1",
      }),
      JSON.stringify({
        time: t,
        tool: "Bash",
        error: "exit 1",
        command: "ls",
        project: "nx",
        session_id: "s2",
      }),
    ]);
    const result = await ingestFailures(1);
    expect(result.parseErrors).toBe(0);
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]!.toolName).toBe("Read");
    expect(result.entries[0]!.project).toBe("nx");
    expect(result.entries[1]!.toolName).toBe("Bash");
  });

  test("multi-day window includes files across the trend window", async () => {
    writeJsonl(`${isoDay(0)}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(0),
        tool: "Read",
        error: "e1",
        command: "c1",
        project: "nx",
      }),
    ]);
    writeJsonl(`${isoDay(3)}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(3),
        tool: "Bash",
        error: "e2",
        command: "c2",
        project: "oo",
      }),
    ]);
    // Trend window for days=2 is [now-4d, now] → both files should be in scope.
    const result = await ingestFailures(2);
    expect(result.entries.length).toBe(2);
  });

  test("malformed lines are counted and never throw", async () => {
    const day = isoDay(0);
    const t = tsDaysAgo(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({
        time: t,
        tool: "Read",
        error: "ok",
        command: "c",
        project: "nx",
      }),
      "{not valid json", // truncated line
      "also not json",
      JSON.stringify({
        time: t,
        tool: "Bash",
        error: "ok",
        command: "c",
        project: "nx",
      }),
    ]);
    const result = await ingestFailures(1);
    expect(result.entries.length).toBe(2);
    expect(result.parseErrors).toBe(2);
  });

  test("accepts the spec-text long-key schema (tool_name / timestamp / error_snippet)", async () => {
    const day = isoDay(0);
    const t = tsDaysAgo(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({
        timestamp: t,
        tool_name: "Read",
        error_snippet: "ENOENT",
        command_snippet: "cat foo",
        project: "nx",
        session_id: "s1",
      }),
    ]);
    const result = await ingestFailures(1);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.toolName).toBe("Read");
    expect(result.entries[0]!.errorSnippet).toBe("ENOENT");
    expect(result.entries[0]!.commandSnippet).toBe("cat foo");
  });

  test("cache hit within TTL skips re-read", async () => {
    const day = isoDay(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(0),
        tool: "Read",
        error: "ok",
        command: "c",
        project: "nx",
      }),
    ]);
    const first = await ingestFailures(1);
    expect(first.entries.length).toBe(1);

    // Mutate the file after the cache populates. A re-read would see 0
    // valid lines; the cache MUST hide the change.
    writeFileSync(join(dir, `${day}.jsonl`), "garbage\n");

    const second = await ingestFailures(1);
    expect(second.entries.length).toBe(1);
    // Identity check confirms it's the same cached object.
    expect(second).toBe(first);
  });

  test("clearFailuresCache forces a fresh read", async () => {
    const day = isoDay(0);
    writeJsonl(`${day}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(0),
        tool: "Read",
        error: "ok",
        command: "c",
        project: "nx",
      }),
    ]);
    const first = await ingestFailures(1);
    expect(first.entries.length).toBe(1);

    writeFileSync(join(dir, `${day}.jsonl`), "");
    clearFailuresCache();

    const second = await ingestFailures(1);
    expect(second.entries.length).toBe(0);
  });

  test("ignores non-jsonl files in the failures dir", async () => {
    writeFileSync(join(dir, "README.md"), "ignore me");
    mkdirSync(join(dir, "subdir"));
    writeJsonl(`${isoDay(0)}.jsonl`, [
      JSON.stringify({
        time: tsDaysAgo(0),
        tool: "Read",
        error: "ok",
        command: "c",
        project: "nx",
      }),
    ]);
    const result = await ingestFailures(1);
    expect(result.entries.length).toBe(1);
  });
});
