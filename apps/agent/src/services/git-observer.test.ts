/**
 * Git status observer tests (add-git-status-orbit, task 4.1).
 *
 * Coverage backfill for already-landed logic (git-observer.ts shipped in the
 * E2E batch). Five seams from the task's Testing description:
 *
 *   1. Baseline-then-transition — against a REAL temp git repo (os.tmpdir() +
 *      `git init` / real commits / branches via child_process), the first
 *      observation establishes a baseline (no event) and a subsequent
 *      observation after a real `git commit` / `git checkout -b` /
 *      `git checkout --detach` yields the correct new_commit / branch_switch /
 *      detached_head transition.
 *   2. First observation emits no events — both at the pure-diff level
 *      (`detectGitTransition(undefined, …) === null`) and through
 *      `startGitObserver`'s first tick over a fresh repo (zero `onEvent`
 *      calls, current-state map populated).
 *   3. Non-repo / missing location fail-open — `observeGitState` returns
 *      `null` (no throw) for a dir that is not a git repo and for a path that
 *      does not exist, and a broken project in a batch leaves its siblings'
 *      observations unaffected.
 *   4. Per-project timeout abandonment — a git observation given a tiny
 *      timeout is abandoned (fail-open `null`) well inside the budget, and
 *      through `startGitObserver` a timed-out project produces no state / no
 *      event without hanging the tick (same fail-open path as #3).
 *   5. Staggered batch bounds — with an injected `batchSize` / `batchDelayMs`,
 *      the poll loop observes each batch concurrently and waits the
 *      inter-batch delay before the next batch (mirrors the documented
 *      BATCH_SIZE=4 / 200ms-stagger defaults).
 *
 * Determinism notes:
 *   - git-observer inherently shells out to the real `git` binary, so these
 *     tests use real temp repos + short real waits (matching how
 *     beads-watcher.test.ts handles its fs.watch/poll seams). Repos are
 *     hermetic (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, inline author identity)
 *     and cleaned up in afterEach; every observer handle is stopped.
 *   - The timeout test uses a 1ms budget: `git status` cannot complete within
 *     process-spawn overhead, so the kill-on-timeout path fires deterministically
 *     without a real 2s wait.
 *   - The batch-bounds test injects batchSize=2 / batchDelayMs=300 and asserts
 *     on relative set-times captured by a timing-instrumented state Map, so a
 *     little git latency slop cannot flip the result.
 */

import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { GitStatusObject } from "@nexus/core";
import {
  observeGitState,
  detectGitTransition,
  parseGitStatusV2,
  startGitObserver,
  type GitObservation,
  type GitTransition,
  type GitObserverHandle,
  type GitObserverProject,
} from "./git-observer";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Hermetic git identity + config isolation so the repo builds anywhere. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

/** A real single-commit git repo under os.tmpdir(), branch `main`. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-observer-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "1");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** A temp dir that is NOT a git repo. */
function makeNonRepo(): string {
  return mkdtempSync(join(tmpdir(), "git-observer-nonrepo-"));
}

/**
 * A fake Bun subprocess that HANGS until `kill()` is called (Bun.spawn ignores
 * PATH mutation for binary resolution, so a shell shim can't stand in for a
 * hanging git — we control the process object directly instead). On kill it
 * closes stdout and resolves `exited` to a SIGTERM code so `observeGitState`'s
 * `exitCode !== 0` fail-open branch fires — exactly the real timeout path.
 */
function makeHangingProc(): { stdout: ReadableStream; exited: Promise<number>; kill(): void } {
  let exitResolve!: (code: number) => void;
  let controller!: ReadableStreamDefaultController;
  const stdout = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    stdout,
    exited: new Promise<number>((r) => {
      exitResolve = r;
    }),
    kill() {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
      exitResolve(143); // 128 + SIGTERM
    },
  };
}

// Track temp dirs + live handles for teardown so timers/watches never leak.
const tempDirs: string[] = [];
const openHandles: GitObserverHandle[] = [];

afterEach(() => {
  while (openHandles.length) openHandles.pop()!.stop();
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
function startTracked(deps: Parameters<typeof startGitObserver>[0]): GitObserverHandle {
  const h = startGitObserver(deps);
  openHandles.push(h);
  return h;
}

async function observe(path: string): Promise<GitObservation> {
  const obs = await observeGitState(path);
  if (obs === null) throw new Error(`expected an observation for ${path}`);
  return obs;
}

// ─── 0. parseGitStatusV2 ahead/behind parsing (add-git-ahead-behind-status) ──

describe("parseGitStatusV2 ahead/behind", () => {
  const HEAD =
    "# branch.oid abc123def456abc123def456abc123def456abc1\n# branch.head main\n";

  test("parses `# branch.ab +3 -1` into ahead: 3, behind: 1", () => {
    const obs = parseGitStatusV2(`${HEAD}# branch.ab +3 -1\n`);
    expect(obs).not.toBeNull();
    expect(obs!.ahead).toBe(3);
    expect(obs!.behind).toBe(1);
  });

  test("defaults to ahead: 0, behind: 0 when no `# branch.ab` line (no upstream)", () => {
    const obs = parseGitStatusV2(HEAD);
    expect(obs).not.toBeNull();
    expect(obs!.ahead).toBe(0);
    expect(obs!.behind).toBe(0);
  });
});

// ─── 1. Baseline → transition (new_commit / branch_switch / detached_head) ────

describe("git-observer baseline-then-transition", () => {
  test(
    "first observation is baseline (no event); subsequent commit/branch/detach diff correctly",
    async () => {
      const repo = track(makeRepo());

      // Baseline observation.
      const baseline = await observe(repo);
      expect(baseline.branch).toBe("main");
      expect(baseline.detached).toBe(false);
      expect(baseline.headSha).toMatch(/^[0-9a-f]{40}$/);
      // First observation = baseline: no prior state, no event.
      expect(detectGitTransition(undefined, baseline)).toBeNull();

      // new_commit: a real second commit on the same branch.
      writeFileSync(join(repo, "b.txt"), "2");
      git(repo, ["add", "b.txt"]);
      git(repo, ["commit", "-q", "-m", "second"]);
      const afterCommit = await observe(repo);
      expect(afterCommit.headSha).not.toBe(baseline.headSha);
      const commitTx = detectGitTransition(baseline, afterCommit);
      expect(commitTx?.eventType).toBe("new_commit");
      expect(commitTx?.sha).toBe(afterCommit.headSha);

      // branch_switch: create + land on a new branch (same sha, new ref).
      git(repo, ["checkout", "-q", "-b", "feature"]);
      const afterBranch = await observe(repo);
      expect(afterBranch.branch).toBe("feature");
      expect(afterBranch.detached).toBe(false);
      const branchTx = detectGitTransition(afterCommit, afterBranch);
      expect(branchTx?.eventType).toBe("branch_switch");
      expect(branchTx?.fromRef).toBe("main");
      expect(branchTx?.toRef).toBe("feature");

      // detached_head: check out the bare HEAD sha.
      git(repo, ["checkout", "-q", "--detach"]);
      const afterDetach = await observe(repo);
      expect(afterDetach.detached).toBe(true);
      expect(afterDetach.branch).toBeNull();
      const detachTx = detectGitTransition(afterBranch, afterDetach);
      expect(detachTx?.eventType).toBe("detached_head");
      expect(detachTx?.sha).toBe(afterDetach.headSha);
    },
    { timeout: 15_000 },
  );
});

// ─── 2. First observation emits no events (integration) ──────────────────────

describe("git-observer first observation", () => {
  test(
    "first tick over a fresh repo emits no events but populates current state",
    async () => {
      const repo = track(makeRepo());
      const events: Array<{ project: string; tx: GitTransition }> = [];
      const state = new Map<string, GitStatusObject>();

      startTracked({
        listProjects: (): GitObserverProject[] => [{ code: "P", path: repo }],
        onEvent: (project, tx) => events.push({ project, tx }),
        state,
        pollIntervalMs: 100_000, // one tick only
        perProjectTimeoutMs: 5_000,
      });

      await sleep(400);

      // Baseline poll → no transition emitted…
      expect(events).toHaveLength(0);
      // …but the current-state map is populated for the folded status payload.
      const s = state.get("P");
      expect(s?.branch).toBe("main");
      expect(s?.observedAt).toBeTruthy();
    },
    { timeout: 10_000 },
  );
});

// ─── 3. Non-repo / missing location fail-open ────────────────────────────────

describe("git-observer fail-open", () => {
  test("observeGitState returns null (no throw) for a non-repo and a missing path", async () => {
    const nonRepo = track(makeNonRepo());
    expect(await observeGitState(nonRepo)).toBeNull();
    expect(await observeGitState("/nonexistent/definitely/not/here-xyz")).toBeNull();
  });

  test(
    "a broken project in a batch leaves its siblings' observations unaffected",
    async () => {
      const good = track(makeRepo());
      const nonRepo = track(makeNonRepo());
      const missing = "/nonexistent/definitely/not/here-xyz";
      const events: GitTransition[] = [];
      const state = new Map<string, GitStatusObject>();

      startTracked({
        listProjects: (): GitObserverProject[] => [
          { code: "MISSING", path: missing },
          { code: "NONREPO", path: nonRepo },
          { code: "GOOD", path: good },
        ],
        onEvent: (_project, tx) => events.push(tx),
        state,
        pollIntervalMs: 100_000,
        perProjectTimeoutMs: 5_000,
      });

      await sleep(400);

      // The good repo was observed despite the two broken siblings…
      expect(state.get("GOOD")?.branch).toBe("main");
      // …and the broken siblings set no state and emitted no events.
      expect(state.has("MISSING")).toBe(false);
      expect(state.has("NONREPO")).toBe(false);
      expect(events).toHaveLength(0);
    },
    { timeout: 10_000 },
  );
});

// ─── 4. Per-project timeout abandonment ──────────────────────────────────────

describe("git-observer timeout abandonment", () => {
  test(
    "a hanging git observation is abandoned fail-open, bounded by the budget",
    async () => {
      const repo = track(makeRepo()); // real dir so existsSync passes
      // Restorable spy (not mock.module — that forward-leaks across the suite):
      // every spawn returns a fresh proc that only exits when killed.
      const spy = spyOn(Bun, "spawn").mockImplementation(
        () => makeHangingProc() as unknown as ReturnType<typeof Bun.spawn>,
      );
      try {
        const start = Date.now();
        // 100ms budget vs a proc that never exits on its own → the kill-on-
        // timeout path fires and the observation fails open to null.
        const result = await observeGitState(repo, 100);
        const elapsed = Date.now() - start;
        expect(result).toBeNull();
        // Bounded by the budget — the observation was abandoned, not run out.
        expect(elapsed).toBeLessThan(1_000);
      } finally {
        spy.mockRestore();
      }
    },
    { timeout: 10_000 },
  );

  test(
    "a timed-out project produces no state / no event without hanging the tick",
    async () => {
      const repo = track(makeRepo());
      const events: GitTransition[] = [];
      const state = new Map<string, GitStatusObject>();
      const spy = spyOn(Bun, "spawn").mockImplementation(
        () => makeHangingProc() as unknown as ReturnType<typeof Bun.spawn>,
      );
      try {
        startTracked({
          listProjects: (): GitObserverProject[] => [{ code: "SLOW", path: repo }],
          onEvent: (_project, tx) => events.push(tx),
          state,
          pollIntervalMs: 100_000,
          perProjectTimeoutMs: 100, // force the abandonment path
        });
        await sleep(400); // well past the 100ms timeout
        expect(state.has("SLOW")).toBe(false);
        expect(events).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    },
    { timeout: 10_000 },
  );
});

// ─── 5. Staggered batch bounds ───────────────────────────────────────────────

describe("git-observer staggered batches", () => {
  test(
    "batches are observed concurrently, with the inter-batch delay between them",
    async () => {
      // 4 repos, batchSize=2, batchDelayMs=300 → 2 batches: [p0,p1] then [p2,p3].
      const repos = [makeRepo(), makeRepo(), makeRepo(), makeRepo()].map(track);
      const codes = ["p0", "p1", "p2", "p3"];
      const setAt = new Map<string, number>();

      // A state Map that records the wall-clock time of each successful
      // observation (state.set) — the observable seam for batch timing.
      const state: Map<string, GitStatusObject> = new (class extends Map<
        string,
        GitStatusObject
      > {
        set(key: string, value: GitStatusObject): this {
          if (!setAt.has(key)) setAt.set(key, Date.now());
          return super.set(key, value);
        }
      })();

      startTracked({
        listProjects: (): GitObserverProject[] =>
          codes.map((code, i) => ({ code, path: repos[i]! })),
        state,
        batchSize: 2,
        batchDelayMs: 300,
        pollIntervalMs: 100_000,
        perProjectTimeoutMs: 5_000,
      });

      // One tick = batch1 + 300ms delay + batch2; wait comfortably past it.
      await sleep(1_200);

      // All four observed.
      for (const c of codes) expect(setAt.has(c)).toBe(true);

      const b1 = [setAt.get("p0")!, setAt.get("p1")!];
      const b2 = [setAt.get("p2")!, setAt.get("p3")!];

      // Within a batch: observed concurrently (Promise.all) — close together,
      // strictly less than the inter-batch delay.
      expect(Math.max(...b1) - Math.min(...b1)).toBeLessThan(300);

      // Across batches: the second batch starts only after the ~300ms stagger
      // (allow slop below the nominal 300ms).
      expect(Math.min(...b2) - Math.max(...b1)).toBeGreaterThanOrEqual(200);
    },
    { timeout: 15_000 },
  );
});
