/**
 * Unit tests for git-project-resolver (session-row-enrichment-v1 § 1.7).
 *
 * Coverage:
 *   1. github HTTPS URL parses to {provider: "github", ownerRepo: "foo/bar"}
 *   2. github SSH form `git@github.com:foo/bar.git` parses identically
 *   3. Azure DevOps URL parses to {provider: "azure-devops", ownerRepo: "org/repo"}
 *   4. Missing git repo (tmpdir without .git) returns null
 *   5. Cache hit within 30s returns the same object reference and does NOT
 *      spawn a second git subprocess.
 *
 * Strategy:
 *   - Tests 1-3 cover the pure URL parser (parseOriginUrl) which needs no
 *     subprocess. Tested as plain unit cases.
 *   - Tests 4-5 cover the full resolver. Test 4 uses a real `mkdtemp`
 *     directory (no `.git`) so the spawn exits non-zero and returns null.
 *     Test 5 initialises a real git repo with a fake origin remote and
 *     verifies (a) the resolver returns a non-null result and (b) the
 *     cache is hit on the second call (same reference, no second spawn).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseOriginUrl,
  resolveProject,
  execGitRemoteUrl,
  __resetCacheForTests,
} from "./git-project-resolver";

// ---------------------------------------------------------------------------
// 1-3. URL parser unit tests
// ---------------------------------------------------------------------------

describe("parseOriginUrl", () => {
  test("github HTTPS URL parses to provider+ownerRepo", () => {
    expect(parseOriginUrl("https://github.com/leonardoacosta/oo.git")).toEqual({
      provider: "github",
      ownerRepo: "leonardoacosta/oo",
    });
  });

  test("github SSH form parses identically to HTTPS", () => {
    expect(parseOriginUrl("git@github.com:leonardoacosta/oo.git")).toEqual({
      provider: "github",
      ownerRepo: "leonardoacosta/oo",
    });
  });

  test("Azure DevOps URL strips the project segment from ownerRepo", () => {
    expect(
      parseOriginUrl("https://dev.azure.com/myorg/myproject/_git/myrepo"),
    ).toEqual({
      provider: "azure-devops",
      ownerRepo: "myorg/myrepo",
    });
  });

  test("Visual Studio Online URL uses subdomain as org", () => {
    expect(
      parseOriginUrl("https://acme.visualstudio.com/proj/_git/billing"),
    ).toEqual({
      provider: "azure-devops",
      ownerRepo: "acme/billing",
    });
  });

  test("gitlab.com HTTPS parses with gitlab provider short-name", () => {
    expect(parseOriginUrl("https://gitlab.com/acme/payments.git")).toEqual({
      provider: "gitlab",
      ownerRepo: "acme/payments",
    });
  });

  test("bitbucket.org SSH parses with bitbucket provider short-name", () => {
    expect(parseOriginUrl("git@bitbucket.org:team/repo.git")).toEqual({
      provider: "bitbucket",
      ownerRepo: "team/repo",
    });
  });

  test("unknown host passes through as the full hostname", () => {
    expect(parseOriginUrl("https://git.example.org/foo/bar.git")).toEqual({
      provider: "git.example.org",
      ownerRepo: "foo/bar",
    });
  });

  test("empty / malformed URLs return null", () => {
    expect(parseOriginUrl("")).toBeNull();
    expect(parseOriginUrl("not-a-url")).toBeNull();
    expect(parseOriginUrl("https://github.com/justonesegment.git")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4-5. Resolver tests against real tmpdir fixtures
// ---------------------------------------------------------------------------

describe("resolveProject — real subprocess", () => {
  beforeEach(() => {
    __resetCacheForTests();
  });

  test("missing git repo (tmpdir without .git) returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-resolver-nogit-"));
    try {
      const result = await resolveProject(dir, null);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache hit within 30s reuses result without re-spawning git", async () => {
    // Initialise a real git repo with a fake origin remote so the resolver
    // gets a real subprocess success on the first call.
    const dir = mkdtempSync(join(tmpdir(), "nx-resolver-cache-"));
    try {
      await Bun.spawn(["git", "init", "-q", dir]).exited;
      await Bun.spawn([
        "git",
        "-C",
        dir,
        "remote",
        "add",
        "origin",
        "https://github.com/test/fixture.git",
      ]).exited;

      // First call — real spawn.
      const first = await resolveProject(dir, null);
      expect(first).not.toBeNull();
      expect(first!.provider).toBe("github");
      expect(first!.ownerRepo).toBe("test/fixture");
      // projectId null because no DB was passed and registry lookup is skipped.
      expect(first!.projectId).toBeNull();

      // Now remove the origin remote: if the cache is hit the resolver
      // should still return the cached non-null result. If the cache is
      // bypassed and a fresh spawn runs, the resolver would return null.
      await Bun.spawn(["git", "-C", dir, "remote", "remove", "origin"]).exited;

      // Sanity check: a fresh subprocess call now returns null (proves the
      // remote really was removed — otherwise the cache assertion would be
      // vacuously true).
      const fresh = await execGitRemoteUrl(dir);
      expect(fresh).toBeNull();

      // Second resolver call — must hit the cache and return the SAME
      // object reference as the first call.
      const second = await resolveProject(dir, null);
      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
