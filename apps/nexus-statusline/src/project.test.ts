/**
 * Unit tests for deriveProjectCode's registry-based resolution.
 *
 * Root cause this locks in: the ORIGINAL implementation was a naive
 * `/dev/<first-segment>` string heuristic that silently derived the
 * CATEGORY folder name instead of the actual project code for anything
 * nested under a category subdirectory (`dev/priceless/tribal-cities` ->
 * "priceless", `dev/personal/nv` -> "personal" — never "tc"/"nv"). That
 * wrote/read the WRONG `roadmap-pulse.<code>.line` cache file, and every
 * project sharing a category collided onto the SAME wrong file. Confirmed
 * live 2026-07-13 against the real machine: tc/nv's real cache files sat 3
 * days stale while priceless.line/personal.line kept getting fresh
 * wrong-project writes every render.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { deriveProjectCode, _resetProjectRegistryCacheForTests } from "./project";

describe("deriveProjectCode", () => {
  let savedDotfiles: string | undefined;
  let testDir: string;

  beforeEach(() => {
    savedDotfiles = process.env.DOTFILES;
    testDir = mkdtempSync(join(tmpdir(), "nx-project-registry-test-"));
    _resetProjectRegistryCacheForTests();
  });

  afterEach(() => {
    if (savedDotfiles === undefined) delete process.env.DOTFILES;
    else process.env.DOTFILES = savedDotfiles;
    rmSync(testDir, { recursive: true, force: true });
    _resetProjectRegistryCacheForTests();
  });

  function writeRegistry(entries: Array<{ code: string; path: string }>): void {
    mkdirSync(join(testDir, "home"), { recursive: true });
    const body = entries
      .map((e) => `[[projects]]\ncode = "${e.code}"\nname = "Test ${e.code}"\npath = "${e.path}"\n`)
      .join("\n");
    writeFileSync(join(testDir, "home", "projects.toml"), body);
    process.env.DOTFILES = testDir;
  }

  test("nested category path resolves to the REAL project code, not the category name", () => {
    // The exact bug shape: a project registered under dev/<category>/<name>.
    const relPath = "nx-project-test-priceless-nested-zzz/tribal-cities";
    const realDir = join(homedir(), relPath);
    mkdirSync(realDir, { recursive: true });
    try {
      writeRegistry([{ code: "tc", path: relPath }]);
      expect(deriveProjectCode(realDir)).toBe("tc");
      // The OLD heuristic would have returned the category segment instead —
      // pin that down explicitly so a regression is unambiguous.
      expect(deriveProjectCode(realDir)).not.toBe("nx-project-test-priceless-nested-zzz");
    } finally {
      rmSync(join(homedir(), "nx-project-test-priceless-nested-zzz"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("a subdirectory of a registered project resolves to the owning code", () => {
    const relPath = "nx-project-test-subdir-zzz/proj";
    const realDir = join(homedir(), relPath);
    mkdirSync(join(realDir, "packages", "api"), { recursive: true });
    try {
      writeRegistry([{ code: "zz", path: relPath }]);
      expect(deriveProjectCode(join(realDir, "packages", "api"))).toBe("zz");
    } finally {
      rmSync(join(homedir(), "nx-project-test-subdir-zzz"), { recursive: true, force: true });
    }
  });

  test("symlink-alias registry entry resolves when queried via the real target", () => {
    const realTargetRel = "nx-project-test-real-target-zzz";
    const aliasRel = "nx-project-test-alias-zzz";
    const realTarget = join(homedir(), realTargetRel);
    const alias = join(homedir(), aliasRel);
    mkdirSync(realTarget, { recursive: true });
    try {
      symlinkSync(realTarget, alias);
    } catch {
      return; // no symlink permission on this filesystem — skip, not a failure
    }
    try {
      writeRegistry([{ code: "al", path: aliasRel }]);
      expect(deriveProjectCode(alias)).toBe("al");
      expect(deriveProjectCode(realTarget)).toBe("al");
    } finally {
      rmSync(alias, { force: true });
      rmSync(realTarget, { recursive: true, force: true });
    }
  });

  test("unregistered directory falls back to the legacy /dev/<segment> heuristic", () => {
    writeRegistry([{ code: "zz", path: "nx-project-test-unrelated-zzz" }]);
    expect(deriveProjectCode("/home/someone/dev/scratch-project")).toBe("scratch-project");
  });

  test("no registry file at all -> falls back to the legacy heuristic, never throws", () => {
    process.env.DOTFILES = join(testDir, "does-not-exist");
    expect(() => deriveProjectCode("/home/someone/dev/whatever")).not.toThrow();
    expect(deriveProjectCode("/home/someone/dev/whatever")).toBe("whatever");
  });

  test(".claude special-case still resolves to cc when no registry entry matches", () => {
    process.env.DOTFILES = join(testDir, "does-not-exist");
    expect(deriveProjectCode("/home/someone/.claude")).toBe("cc");
  });
});
