/**
 * Unit tests for transcript-locator.
 *
 * Tests path computation and the three discovery modes:
 * 1. File exists immediately
 * 2. File appears within the 5s watch window
 * 3. Timeout returns null
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { homedir } from "node:os";

// We need to test the module by mocking fs functions.
// Since Bun doesn't support vi.mock, we test the path computation logic
// directly and use the real function with temp directories for integration.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { locateTranscript } from "./transcript-locator";

// ---------------------------------------------------------------------------
// Path computation tests (no I/O)
// ---------------------------------------------------------------------------

describe("transcript-locator: path computation", () => {
  it("encodes cwd by replacing '/' with '-'", () => {
    // The expected path for cwd="/home/user/project" is:
    // ~/.claude/projects/-home-user-project/<ccSessionId>.jsonl
    const cwd = "/home/user/project";
    const encodedCwd = cwd.replaceAll("/", "-");
    expect(encodedCwd).toBe("-home-user-project");

    const expectedDir = path.join(
      homedir(),
      ".claude",
      "projects",
      encodedCwd,
    );
    const expectedPath = path.join(expectedDir, "test-uuid.jsonl");
    expect(expectedPath).toContain("-home-user-project");
    expect(expectedPath).toEndWith("test-uuid.jsonl");
  });

  it("preserves leading '-' from root '/'", () => {
    const cwd = "/";
    const encoded = cwd.replaceAll("/", "-");
    expect(encoded).toBe("-");
  });
});

// ---------------------------------------------------------------------------
// File-exists-immediately test (uses real tmp dir)
// ---------------------------------------------------------------------------

describe("transcript-locator: file discovery", () => {
  const testBaseDir = path.join(homedir(), ".claude", "projects");
  // Use a unique cwd that won't collide with real projects
  const fakeCwd = `/tmp/nx-test-locator-${Date.now()}`;
  const encodedCwd = fakeCwd.replaceAll("/", "-");
  const testDir = path.join(testBaseDir, encodedCwd);
  const ccSessionId = `test-session-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("returns the path immediately when file already exists", async () => {
    const filePath = path.join(testDir, `${ccSessionId}.jsonl`);
    writeFileSync(filePath, "");

    const result = await locateTranscript(fakeCwd, ccSessionId);
    expect(result).toBe(filePath);
  });

  it("returns the path when file appears within the watch window", async () => {
    const filePath = path.join(testDir, `${ccSessionId}.jsonl`);

    // Start the locate, then create the file after a short delay
    const resultPromise = locateTranscript(fakeCwd, ccSessionId);

    // Create the file after 200ms (well within 5s timeout)
    setTimeout(() => {
      writeFileSync(filePath, "");
    }, 200);

    const result = await resultPromise;
    expect(result).toBe(filePath);
  });

  it("returns null when file does not appear within timeout", async () => {
    // Use a unique session ID that will never be created
    const missingSessionId = `missing-${Date.now()}-${Math.random()}`;

    const result = await locateTranscript(fakeCwd, missingSessionId);
    expect(result).toBeNull();
  }, 10_000); // extend test timeout to 10s (function waits 5s)
});
