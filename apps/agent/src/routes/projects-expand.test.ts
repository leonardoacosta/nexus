/**
 * expandProjectsDir tests — tilde expansion, absolute/relative path handling.
 */

// Import mocks first (required before unit under test)
import "./projects-discovered.helpers";

import { describe, expect, it } from "bun:test";
import { expandProjectsDir } from "./projects-discovered";
import os from "node:os";
import path from "node:path";

// ── Tilde expansion tests (Spec 1, task 3.1) ──────────────────────────────────

describe("expandProjectsDir", () => {
  it("expands leading ~ to home directory", () => {
    const result = expandProjectsDir("~/dev");
    expect(result).toBe(path.join(os.homedir(), "dev"));
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("returns absolute path unchanged", () => {
    const result = expandProjectsDir("/tmp/projects");
    expect(result).toBe("/tmp/projects");
  });

  it("resolves relative path to absolute via path.resolve", () => {
    const result = expandProjectsDir("relative/path");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("expands ~/ prefix to home directory", () => {
    const result = expandProjectsDir("~/foo/bar");
    expect(result).toBe(path.join(os.homedir(), "foo", "bar"));
  });
});
