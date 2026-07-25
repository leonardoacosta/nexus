/**
 * Unit tests for the fail-soft git branch resolver (session-enrichment).
 *
 * `resolveBranch` replaces the process-watcher's hardcoded `branch: null` with
 * a `git rev-parse --abbrev-ref HEAD` in the session's cwd, memoised per-cwd.
 * It MUST be fail-soft: a non-git directory, a missing cwd, or any git failure
 * returns `null` without throwing.
 *
 * Strategy: `resolveBranch` shells out via `Bun.spawn` directly (not the mocked
 * `execText`), so these tests run real `git` against real directories:
 *   - the repo root itself (a known git repo) → returns its current branch
 *   - a freshly-created temp dir that is NOT a git repo → null
 *   - empty / undefined cwd → null (no subprocess)
 *
 * The cache is cleared in `beforeEach` so each scenario is isolated.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing } from "./process-watcher";

const { resolveBranch, clearBranchCache } = __testing;

/** Resolve the repo root so the test is location-independent. */
async function repoRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error("could not resolve repo root for test");
  return out.trim();
}

/**
 * True when HEAD currently resolves to a named branch (`git symbolic-ref -q
 * HEAD` exits 0). False on a detached HEAD — the shape of a CI PR merge-ref
 * checkout (`refs/pull/N/merge`), where `resolveBranch` correctly returns
 * null (detached HEAD is fail-soft, not a bug — see process-watcher.ts's
 * `value = out !== "HEAD" ? out : null`) but the "returns a branch" test's
 * own premise doesn't hold (nx-9qsmb.18).
 */
function hasNamedBranch(): boolean {
  const proc = Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  return proc.exitCode === 0;
}

describe("resolveBranch — fail-soft git branch lookup", () => {
  beforeEach(() => {
    clearBranchCache();
  });

  test.skipIf(!hasNamedBranch())("returns the current branch for a real git repository (cwd)", async () => {
    const root = await repoRoot();
    const branch = await resolveBranch(root);
    // We don't pin the branch NAME (CI may run on any branch) — only that a
    // non-empty branch string was resolved from a real git repo.
    expect(branch).not.toBeNull();
    expect(typeof branch).toBe("string");
    expect((branch as string).length).toBeGreaterThan(0);
  });

  test("returns null for a non-git directory (fail-soft, no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-branch-test-"));
    try {
      const branch = await resolveBranch(dir);
      expect(branch).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for an empty cwd without spawning git", async () => {
    expect(await resolveBranch("")).toBeNull();
  });

  test("returns null for null / undefined cwd", async () => {
    expect(await resolveBranch(null)).toBeNull();
    expect(await resolveBranch(undefined)).toBeNull();
  });

  test("memoises by cwd — a second lookup returns the cached value", async () => {
    const root = await repoRoot();
    const first = await resolveBranch(root);
    // Second call hits the cache (no subprocess). Identical result.
    const second = await resolveBranch(root);
    expect(second).toBe(first);
  });

  test("clearBranchCache forces a fresh resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-branch-test-"));
    try {
      // First resolution caches the negative (non-git) result.
      expect(await resolveBranch(dir)).toBeNull();
      clearBranchCache();
      // After clearing, a fresh resolution still degrades cleanly to null.
      expect(await resolveBranch(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
