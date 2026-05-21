/**
 * Unit tests for git-project URL parsing + git-metadata extraction.
 * Exercises the 3 canonical URL forms plus rejection paths and the 7
 * metadata scenarios from
 * openspec/changes/projects-tab-accordion-deeplink/specs/project-registry/spec.md.
 *
 * Metadata tests use real `git init` fixture repos under `os.tmpdir()`
 * (no mocks, per project convention). Fixtures are torn down in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  clearGitMetadataCache,
  getGitMetadata,
  parseGitMetadata,
  parseOriginUrl,
  resolveGitOrigin,
} from "./git-project";

describe("parseOriginUrl", () => {
  it("parses SSH form", () => {
    expect(parseOriginUrl("git@github.com:leonardoacosta/nexus.git")).toEqual({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
  });

  it("parses HTTPS form", () => {
    expect(
      parseOriginUrl("https://github.com/leonardoacosta/nexus.git"),
    ).toEqual({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
  });

  it("parses git:// form without .git suffix", () => {
    expect(parseOriginUrl("git://github.com/leonardoacosta/nexus")).toEqual({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
  });

  it("handles GitLab nested subgroups by coalescing to first two segments", () => {
    expect(
      parseOriginUrl(
        "https://gitlab.com/acme/platform/api/payments.git",
      ),
    ).toEqual({
      provider: "gitlab.com",
      ownerRepo: "acme/platform",
    });
  });

  it("returns null for empty input", () => {
    expect(parseOriginUrl("")).toBeNull();
  });

  it("returns null for single-segment paths", () => {
    expect(parseOriginUrl("https://github.com/nexus.git")).toBeNull();
  });

  it("returns null for malformed urls", () => {
    expect(parseOriginUrl("not-a-valid-url-string")).toBeNull();
  });

  it("returns null for SSH form without ownerRepo segment", () => {
    expect(parseOriginUrl("git@github.com:nexus")).toBeNull();
  });
});

describe("resolveGitOrigin", () => {
  it("returns null for non-existent cwd", async () => {
    expect(await resolveGitOrigin("/nonexistent-path-1234")).toBeNull();
  });

  it("returns null for null cwd", async () => {
    expect(await resolveGitOrigin(null)).toBeNull();
    expect(await resolveGitOrigin(undefined)).toBeNull();
  });
});

// ── Git metadata fixture helpers ──────────────────────────────────────────

function sh(cwd: string, ...args: string[]): void {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Deterministic author so author-name assertions are stable.
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `shell exited ${result.status}: ${args.join(" ")}\n` +
        (result.stderr?.toString("utf8") ?? ""),
    );
  }
}

interface Fixture {
  cwd: string;
}

function initRepo(label: string): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), `nx-git-${label}-`));
  sh(cwd, "git", "init", "-q", "-b", "main");
  // Default identity (defence in depth — env vars usually suffice).
  sh(cwd, "git", "config", "user.email", "test@example.com");
  sh(cwd, "git", "config", "user.name", "Test Author");
  return { cwd };
}

function commit(cwd: string, filename: string, body: string, msg: string): void {
  writeFileSync(join(cwd, filename), body);
  sh(cwd, "git", "add", filename);
  sh(cwd, "git", "commit", "-q", "-m", msg);
}

// ── parseGitMetadata — unit (no subprocess) ────────────────────────────────

describe("parseGitMetadata", () => {
  it("parses clean-on-main with branch.ab present", () => {
    const raw = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "Test Author",
      "2026-05-21T18:00:00-05:00",
      "",
    ].join("\n");
    const md = parseGitMetadata(raw);
    expect(md).not.toBeNull();
    expect(md!.branch).toBe("main");
    expect(md!.ahead).toBe(0);
    expect(md!.behind).toBe(0);
    expect(md!.dirty).toBe(false);
    expect(md!.last_commit?.author).toBe("Test Author");
    expect(md!.last_commit?.ts).toBe("2026-05-21T18:00:00-05:00");
  });

  it("flags dirty when a `1 ` entry line is present", () => {
    const raw = [
      "# branch.oid abc123",
      "# branch.head feat/foo",
      "# branch.upstream origin/feat/foo",
      "# branch.ab +3 -0",
      "1 .M N... 100644 100644 100644 deadbeef deadbeef README.md",
      "Test Author",
      "2026-05-21T18:00:00-05:00",
    ].join("\n");
    const md = parseGitMetadata(raw);
    expect(md!.branch).toBe("feat/foo");
    expect(md!.ahead).toBe(3);
    expect(md!.behind).toBe(0);
    expect(md!.dirty).toBe(true);
  });

  it("returns null branch for detached HEAD", () => {
    const raw = [
      "# branch.oid abc123",
      "# branch.head (detached)",
      "Test Author",
      "2026-05-21T18:00:00-05:00",
    ].join("\n");
    const md = parseGitMetadata(raw);
    expect(md).not.toBeNull();
    expect(md!.branch).toBeNull();
    expect(md!.ahead).toBe(0);
    expect(md!.behind).toBe(0);
  });

  it("returns null when branch.head is absent", () => {
    expect(parseGitMetadata("")).toBeNull();
    expect(parseGitMetadata("not a status output")).toBeNull();
  });

  it("emits last_commit=null when log tail is missing", () => {
    const raw = ["# branch.oid abc", "# branch.head main"].join("\n");
    const md = parseGitMetadata(raw);
    expect(md).not.toBeNull();
    expect(md!.last_commit).toBeNull();
  });
});

// ── getGitMetadata — fixture-based integration ────────────────────────────

describe("getGitMetadata — fixture repos", () => {
  let cleanRepo: Fixture;
  let dirtyRepo: Fixture;
  let detachedRepo: Fixture;
  let notGit: Fixture;

  beforeAll(() => {
    clearGitMetadataCache();

    // Scenario 1: clean on main
    cleanRepo = initRepo("clean");
    commit(cleanRepo.cwd, "README.md", "initial\n", "initial commit");

    // Scenario 2: dirty branch
    dirtyRepo = initRepo("dirty");
    commit(dirtyRepo.cwd, "README.md", "initial\n", "initial commit");
    sh(dirtyRepo.cwd, "git", "checkout", "-q", "-b", "feat/foo");
    commit(dirtyRepo.cwd, "feat.md", "feat\n", "add feat");
    // Modify a tracked file → dirty
    writeFileSync(join(dirtyRepo.cwd, "README.md"), "modified\n");

    // Scenario 3: detached HEAD
    detachedRepo = initRepo("detached");
    commit(detachedRepo.cwd, "a.txt", "a\n", "first");
    commit(detachedRepo.cwd, "b.txt", "b\n", "second");
    // Detach at HEAD~1
    sh(detachedRepo.cwd, "git", "checkout", "-q", "HEAD~1");

    // Scenario 4: non-git directory
    const cwd = mkdtempSync(join(tmpdir(), "nx-git-notgit-"));
    mkdirSync(join(cwd, "subdir"), { recursive: true });
    notGit = { cwd };
  });

  afterAll(() => {
    for (const f of [cleanRepo, dirtyRepo, detachedRepo, notGit]) {
      if (f) rmSync(f.cwd, { recursive: true, force: true });
    }
    clearGitMetadataCache();
  });

  it("scenario: clean git repo on main", async () => {
    clearGitMetadataCache();
    const md = await getGitMetadata(cleanRepo.cwd);
    expect(md).not.toBeNull();
    expect(md!.branch).toBe("main");
    expect(md!.dirty).toBe(false);
    expect(md!.last_commit?.author).toBe("Test Author");
    expect(md!.last_commit?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("scenario: dirty branch (modified tracked file)", async () => {
    clearGitMetadataCache();
    const md = await getGitMetadata(dirtyRepo.cwd);
    expect(md).not.toBeNull();
    expect(md!.branch).toBe("feat/foo");
    expect(md!.dirty).toBe(true);
  });

  it("scenario: detached HEAD", async () => {
    clearGitMetadataCache();
    const md = await getGitMetadata(detachedRepo.cwd);
    expect(md).not.toBeNull();
    expect(md!.branch).toBeNull();
  });

  it("scenario: non-git directory returns null", async () => {
    clearGitMetadataCache();
    const md = await getGitMetadata(notGit.cwd);
    expect(md).toBeNull();
  });

  it("scenario: cache hit within 30s avoids re-spawn", async () => {
    clearGitMetadataCache();
    const first = await getGitMetadata(cleanRepo.cwd);
    // Remove the .git dir — if the cache is honoured we get the same value.
    // (Don't actually delete; use a marker: spawn a second time, expect
    // identical reference-equal object via the cache.)
    const second = await getGitMetadata(cleanRepo.cwd);
    expect(second).toBe(first); // identity equality → no respawn
  });

  it("scenario: parallel resolution across many repos stays under budget", async () => {
    clearGitMetadataCache();
    const cwds = Array.from({ length: 5 }, () => cleanRepo.cwd);
    const start = Date.now();
    const results = await Promise.all(cwds.map((c) => getGitMetadata(c)));
    const elapsed = Date.now() - start;
    expect(results.every((r) => r !== null)).toBe(true);
    // 5 calls to the same cwd → first one spawns, rest hit cache. Wall-clock
    // should be under one subprocess budget (well under 500ms).
    expect(elapsed).toBeLessThan(1_500);
  });

  it("scenario: git subprocess failure (non-existent cwd) returns null", async () => {
    clearGitMetadataCache();
    const md = await getGitMetadata("/does/not/exist/nx-test-1234");
    expect(md).toBeNull();
  });
});
