# Plan 011: Resolve per-project `git remote get-url` with bounded parallelism in the discovery scan

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/routes/projects-discovered.ts apps/agent/src/services/credential-usage-poller.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`scanProjects` in `apps/agent/src/routes/projects-discovered.ts` awaits one
`git remote get-url origin` subprocess **per candidate directory, inside the
scan loop**. With N git repos under a projects dir, that is N *sequential*
subprocess spawns, each capped at 500ms. Worst case is the scan cap
(`PAGINATED_SCAN_CAP = 1_000`) serialized → a single scan can stall many
seconds. This runs on every cache miss (5s TTL) and on the 60s scheduled
discovery loop, so a large projects dir makes the `/projects/discovered`
endpoint and the registry-refresh loop chronically slow. Collecting the
candidate dirs first and then resolving the git remotes with a
**concurrency-limited pool** cuts the wall time to roughly (N / concurrency)
× per-call latency, with byte-for-byte identical output. (Bonus: the existing
101-repo test currently spawns 100 real `git` processes serially and has a
120s timeout for that reason — parallelizing it makes that test fast too.)

## Current state

Files:

- `apps/agent/src/routes/projects-discovered.ts` — the discovery scan route.
  `scanProjects` (lines ~212–298) contains the sequential loop; `getGitRemoteUrl`
  (lines ~151–171) spawns the git subprocess with a 500ms timeout. This file
  already uses an **injectable-shim testing pattern** (`__setFsForTesting`,
  `__setDepsForTesting` at lines 43–69) — the new git-resolver seam MUST follow
  the same shape.
- `apps/agent/src/services/credential-usage-poller.ts` — contains the
  bounded-concurrency pool **exemplar to match**: `runPool<T, R>` (lines
  214–233) and its use `await runPool(rows, POLL_CONCURRENCY, …)` with
  `const POLL_CONCURRENCY = 4;` (line 44, used line 302). This is the pattern
  the finding says to match.

The hot loop as it exists today — `apps/agent/src/routes/projects-discovered.ts:237-295`:

```ts
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const fullPath = path.join(projectsDir, entry.name);
    // ... realpathSync → canonicalPath, dedup on seenCanonicalPaths ...
    const isGitRepo = fs.existsSync(path.join(canonicalPath, ".git"));
    const isOpenspecRepo = fs.existsSync(path.join(canonicalPath, "openspec"));
    if (!isGitRepo && !isOpenspecRepo) continue;
    seenCanonicalPaths.add(canonicalPath);
    // ... session cross-reference → activeSessions, totalSessions ...
    const gitRemoteUrl = await getGitRemoteUrl(canonicalPath);   // <-- SEQUENTIAL, line 288
    projects.push({ name, path: canonicalPath, activeSessions, totalSessions, gitRemoteUrl });
    if (projects.length >= cap) {
      truncated = true;
      break;
    }
  }
  return { ok: true, projects, truncated };
```

The exemplar pool — `apps/agent/src/services/credential-usage-poller.ts:214-233`:

```ts
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function run(): Promise<void> {
    while (idx < items.length) {
      const myIdx = idx++;
      results[myIdx] = await worker(items[myIdx]!);
    }
  }
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run(),
  );
  await Promise.all(runners);
  return results;
}
```

Behavioral constraints that MUST be preserved exactly (output equivalence):

- **`truncated` semantics**: today `truncated` becomes `true` the moment the
  collected-project count reaches `cap` (the check runs *after* each push, so
  hitting exactly `cap` candidates sets `truncated: true` and stops). Preserve
  this: cap the number of *candidates collected* at `cap`, and set `truncated`
  when that limit is hit.
- **Which projects are included**: identical set. Candidates are collected in
  entry-iteration order up to `cap`; the git-remote resolution must not change
  membership.
- **Array order out of `scanProjects` is NOT load-bearing**: both HTTP callers
  re-sort (`scan.projects.sort((a,b) => a.name.localeCompare(b.name))` in the
  legacy path, `.sort((a,b) => a.path.localeCompare(b.path))` in the paginated
  path). `runPool` preserves index order anyway, so this is safe.
- **The 500ms per-call timeout inside `getGitRemoteUrl`** stays unchanged.
- **Each `gitRemoteUrl` maps to its own `canonicalPath`** — no cross-wiring.

Repo conventions:

- Bun runtime; tests use `bun:test`. Injectable-shim testing pattern (no
  `mock.module`) — mirror the existing `__setFsForTesting` shape for the new
  git-resolver seam.
- Shared agent utilities live in `apps/agent/src/utils/` (e.g. `exec.ts`,
  `safe-fire-and-forget.ts`). This is the home for the extracted pool.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Discovery tests | `cd apps/agent && bun test projects-discovered` | all pass |
| Poller tests (regression) | `cd apps/agent && bun test credential-usage-poller` | all pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |

Notes: `bun test <filter>` matches test files by substring. Some discovery
tests set `NEXUS_ATTACH_SECRET`/`POSTGRES_URL` for other suites — the
projects-discovered suite is self-contained (fs + deps mocked), so no env is
required for it, but run the full `bun test` in the agent dir before you call
done to catch cross-suite breakage.

## Suggested executor toolkit

- Skill `bun` if available — for `bun:test` mock/timeout idioms.

## Scope

**In scope** (the only files you should modify):

- `apps/agent/src/utils/run-pool.ts` (create) — extracted bounded-concurrency pool.
- `apps/agent/src/services/credential-usage-poller.ts` — replace the local
  `runPool` with an import from the new util (delete the local copy). No
  behavior change.
- `apps/agent/src/routes/projects-discovered.ts` — split the scan into a
  cheap sequential candidate pass + a bounded-parallel git-remote pass; add
  the git-resolver test seam.
- `apps/agent/src/routes/projects-discovered.helpers.ts` — wire the new
  git-resolver mock into the shared test setup.
- `apps/agent/src/routes/projects-discovered-core.test.ts` — add the
  parallelism + mapping test.

**Out of scope** (do NOT touch, even though they look related):

- The HTTP response shapes / cache logic in `handleGetDiscoveredProjects` —
  no field changes, no status-code changes.
- The `getGitRemoteUrl` body (the `safeSpawn` call, the 500ms
  `AbortSignal.timeout`) — keep it exactly as-is; only its call site moves.
- `PAGINATED_SCAN_CAP` / `LEGACY_SCAN_CAP` values and the cursor/pagination code.
- Any cross-scan memoization of remote URLs (noted as a deferred follow-up below).

## Git workflow

- Branch: `advisor/011-parallelize-git-discovery`
- Commit style: conventional commits. Example from `git log`:
  `perf(agent): parallelize per-project git remote resolution in discovery scan`
- Do NOT push or open a PR.

## Steps

### Step 1: Extract `runPool` into a shared util

Create `apps/agent/src/utils/run-pool.ts` containing the exact `runPool<T, R>`
implementation currently at `credential-usage-poller.ts:214-233`, exported:

```ts
/**
 * Run N async tasks with a concurrency cap. Each task receives its input and
 * returns a promise; the returned array is index-aligned with `items`.
 * Failures propagate to the caller (wrap in the worker if you need per-item
 * error isolation).
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function run(): Promise<void> {
    while (idx < items.length) {
      const myIdx = idx++;
      results[myIdx] = await worker(items[myIdx]!);
    }
  }
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run(),
  );
  await Promise.all(runners);
  return results;
}
```

Then in `credential-usage-poller.ts`: delete the local `runPool` function
(lines 210–233, including its doc comment) and add
`import { runPool } from "../utils/run-pool";` alongside the other imports.
The existing call site `await runPool(rows, POLL_CONCURRENCY, …)` is unchanged.

**Verify**: `cd apps/agent && bun test credential-usage-poller` → all pass
(no behavior change, only the function moved).

### Step 2: Add the git-resolver test seam

In `apps/agent/src/routes/projects-discovered.ts`, mirror the existing
`__setFsForTesting` shim pattern so the git-remote resolver can be replaced in
tests (there is currently no seam — the 101-repo test spawns real `git`).

After the `getGitRemoteUrl` definition (~line 171), add:

```ts
/** Injectable git-remote resolver (see __setFsForTesting rationale above). */
let resolveGitRemote: (projectPath: string) => Promise<string | null> = getGitRemoteUrl;

/** Test-only: replace the git-remote resolver. */
export function __setGitRemoteResolverForTesting(
  fn: (projectPath: string) => Promise<string | null>,
): void {
  resolveGitRemote = fn;
}

/** Test-only: restore the real git-remote resolver. */
export function __resetGitRemoteResolverForTesting(): void {
  resolveGitRemote = getGitRemoteUrl;
}
```

Do NOT call `getGitRemoteUrl` directly from `scanProjects` after this step —
Step 3 routes through `resolveGitRemote`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Split `scanProjects` into a candidate pass + a bounded-parallel resolve pass

Add a concurrency constant near the other constants (~line 88, after
`PAGINATED_SCAN_CAP`):

```ts
/**
 * Max parallel `git remote get-url` subprocess spawns during a discovery scan.
 * Matches the bounded-pool pattern in
 * services/credential-usage-poller.ts (POLL_CONCURRENCY). Git calls are local
 * (no network), so a higher cap than the poller's 4 is fine; keep it bounded
 * so a huge projects dir can't fork 1000 subprocesses at once.
 */
const GIT_REMOTE_CONCURRENCY = 8;
```

Import the pool at the top of the file:
`import { runPool } from "../utils/run-pool";`

Rewrite the loop in `scanProjects` (lines ~237–297). First pass collects
candidates (everything cheap and synchronous — realpath, dedup, git/openspec
filter, session counting) **without** touching git, applying the cap here.
Second pass resolves git remotes in parallel and assembles the final array:

```ts
  // Pass 1 — collect candidates (cheap, sequential). Cap here to preserve the
  // exact truncated semantics: hitting `cap` collected candidates sets
  // truncated and stops, identical to the pre-parallel behavior.
  interface Candidate {
    name: string;
    canonicalPath: string;
    activeSessions: number;
    totalSessions: number;
  }
  const candidates: Candidate[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const fullPath = path.join(projectsDir, entry.name);

    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(fullPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ fullPath, error: message }, "realpathSync failed — skipping entry");
      continue;
    }

    if (seenCanonicalPaths.has(canonicalPath)) continue;

    const isGitRepo = fs.existsSync(path.join(canonicalPath, ".git"));
    const isOpenspecRepo = fs.existsSync(path.join(canonicalPath, "openspec"));
    if (!isGitRepo && !isOpenspecRepo) continue;

    seenCanonicalPaths.add(canonicalPath);

    const name = entry.name;
    const nowMs = Date.now();
    let activeSessions = 0;
    let totalSessions = 0;
    for (const s of recentSessions) {
      const matchesCwd = s.cwd?.startsWith(canonicalPath) || s.cwd?.startsWith(fullPath);
      if (!matchesCwd) continue;
      totalSessions++;
      const isActive =
        s.status === "active" ||
        (s.lastActivity && nowMs - s.lastActivity.getTime() < ACTIVE_SESSION_WINDOW_MS);
      if (isActive) activeSessions++;
    }

    candidates.push({ name, canonicalPath, activeSessions, totalSessions });
    if (candidates.length >= cap) {
      truncated = true;
      break;
    }
  }

  // Pass 2 — resolve git remotes with a bounded pool (was N sequential awaits).
  const remoteUrls = await runPool(
    candidates,
    GIT_REMOTE_CONCURRENCY,
    (c) => resolveGitRemote(c.canonicalPath),
  );

  const projects: AgentDiscoveredProject[] = candidates.map((c, i) => ({
    name: c.name,
    path: c.canonicalPath,
    activeSessions: c.activeSessions,
    totalSessions: c.totalSessions,
    gitRemoteUrl: remoteUrls[i]!,
  }));

  return { ok: true, projects, truncated };
```

Keep everything above the loop (the `queryRecentSessions` fetch, `readdirSync`,
the `seenCanonicalPaths = new Set()` reset) exactly as-is. Remove the old
`const projects: AgentDiscoveredProject[] = [];` and `let truncated = false;`
declarations that preceded the loop, since they are re-declared above.

**Verify**: `cd apps/agent && bun test projects-discovered` → all pass
(existing tests assert output equivalence: 101→truncated, git filtering,
session counts, response shape). Then `pnpm typecheck` → exit 0.

### Step 4: Wire the git-resolver mock into the shared test helpers

In `apps/agent/src/routes/projects-discovered.helpers.ts`, import
`__setGitRemoteResolverForTesting` and add a default mock alongside the fs/deps
mocks, so real `git` is never spawned in the suite:

```ts
// import list:
import {
  __setFsForTesting,
  __setDepsForTesting,
  __setGitRemoteResolverForTesting,
} from "./projects-discovered";

// after the existing mocks:
export const mockResolveGitRemote =
  mock((_p: string): Promise<string | null> => Promise.resolve(null));
__setGitRemoteResolverForTesting(
  mockResolveGitRemote as unknown as (p: string) => Promise<string | null>,
);
```

Add its reset to `resetMocks()`:

```ts
  mockResolveGitRemote.mockImplementation(() => Promise.resolve(null));
```

Defaulting to `Promise.resolve(null)` preserves current test expectations
(existing tests never assert a non-null `gitRemoteUrl`; the real resolver
returned null in tests because the mocked dirs have no git).

**Verify**: `cd apps/agent && bun test projects-discovered` → all pass, and the
101-repo test (`sets truncated: true when more than 100 git repos exist`) now
completes fast (no real subprocess spawns). Do NOT remove its `{ timeout:
120_000 }` in this plan — leave it as a safety margin.

## Test plan

Add ONE focused test to
`apps/agent/src/routes/projects-discovered-core.test.ts` that proves the two
properties the finding requires: correct per-dir mapping and bounded
concurrency. Model it after the existing tests in that file (same imports,
`makeDb`/`makeAgentRow`/`dirent`/mock helpers).

```ts
import { mockResolveGitRemote } from "./projects-discovered.helpers";
// ...

it("resolves git remote per dir with bounded concurrency (respects the cap)", async () => {
  const db = makeDb([makeAgentRow({ projectsDir: "/home/user/many" })]);

  const dirs = Array.from({ length: 20 }, (_, i) =>
    dirent(`repo-${String(i).padStart(2, "0")}`, true),
  );
  mockReaddirSync.mockImplementation(
    () => dirs as unknown as ReturnType<typeof import("node:fs").readdirSync>,
  );
  mockExistsSync.mockImplementation((p: string) => p.endsWith("/.git"));

  // Instrument the resolver: track live concurrency and return a per-path URL.
  let live = 0;
  let maxLive = 0;
  mockResolveGitRemote.mockImplementation(async (p: string) => {
    live++;
    maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, 5)); // force overlap
    live--;
    return `git@example.com:${p}.git`;
  });

  const res = await handleGetDiscoveredProjects(db);
  expect(res.status).toBe(200);
  const body = await res.json() as {
    projects: Array<{ path: string; gitRemoteUrl: string | null }>;
  };

  // Called once per candidate dir.
  expect(mockResolveGitRemote).toHaveBeenCalledTimes(20);
  // Each project's remote maps to its own path (no cross-wiring).
  for (const p of body.projects) {
    expect(p.gitRemoteUrl).toBe(`git@example.com:${p.path}.git`);
  }
  // Bounded parallelism — never exceeds the cap (GIT_REMOTE_CONCURRENCY = 8).
  expect(maxLive).toBeGreaterThan(1);   // proves it actually parallelized
  expect(maxLive).toBeLessThanOrEqual(8);
});
```

If `GIT_REMOTE_CONCURRENCY` is changed from 8, update the `8` in the assertion
to match (or import and reference the constant if you choose to export it —
optional, not required).

Verification: `cd apps/agent && bun test projects-discovered` → all pass,
including the new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `cd apps/agent && bun test projects-discovered` → all pass, including the
      new bounded-concurrency test
- [ ] `cd apps/agent && bun test credential-usage-poller` → all pass (runPool
      extraction caused no regression)
- [ ] `grep -n "await getGitRemoteUrl" apps/agent/src/routes/projects-discovered.ts`
      returns no matches (the sequential in-loop await is gone)
- [ ] `grep -n "async function runPool" apps/agent/src/services/credential-usage-poller.ts`
      returns no matches (local copy removed; imported from utils)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer owns the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `projects-discovered.ts` or `credential-usage-poller.ts`
  changed since `64a206ff` and the "Current state" excerpts no longer match.
- `runPool` in `credential-usage-poller.ts` is no longer the exact shape shown
  (e.g. it grew per-item error handling) — extracting it verbatim would then
  change poller behavior; report instead.
- The existing `truncated: true` / git-filtering / session-count tests fail
  after Step 3 — that means output equivalence broke; do not "fix" the tests to
  match new behavior.
- Making the git-resolver mockable requires touching any file outside the scope
  list.
- The assumption "both HTTP callers re-sort `scan.projects`, so out-of-loop
  order is not load-bearing" turns out to be false (a caller consumes
  `scan.projects` order directly).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **Reviewer focus**: confirm the `truncated` cap is applied to *candidate
  collection* (Pass 1), not after git resolution — moving it would change the
  cutoff set. Confirm `remoteUrls[i]` is index-aligned with `candidates[i]`
  (`runPool` guarantees this; a `.map`/`filter` inserted between the passes
  would break it).
- **`runPool` is now shared** (`utils/run-pool.ts`) between the poller and the
  discovery scan. It has no per-item error isolation — the discovery worker is
  safe because `getGitRemoteUrl` swallows its own errors and returns null; any
  future caller that passes a throwing worker will abort the whole pool.
- **Deferred follow-up (out of scope here)**: memoize resolved remote URLs by
  canonical path across scans (remote URLs change rarely). That would cut the
  git spawns to only new/changed dirs, but needs an invalidation story (repo
  re-cloned, remote re-pointed) — file a separate issue if the parallelized
  cost is still measurable on very large projects dirs.
- If `getGitRemoteUrl` ever gains a longer timeout or retries, revisit
  `GIT_REMOTE_CONCURRENCY` — more concurrency × longer per-call time raises the
  peak subprocess count.
