# Plan 035: Convert beads-watcher.ts + bead-rollup.ts recurring IO to async fs and batch the startup fan-out

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 089e0338..HEAD -- apps/agent/src/services/beads-watcher.ts apps/agent/src/services/bead-rollup.ts apps/agent/src/services/spec-watcher/index.ts apps/agent/src/services/spec-watcher/constants.ts apps/agent/src/routes/beads-unlinked.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on
> a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `089e0338`, 2026-07-13

## Why this matters

`beads-watcher.ts` recounts every registered project's unlinked ready/blocked
bead counts on a 60s timer (plus a debounced fs-watch trigger) — and does it
with fully synchronous filesystem calls: `computeBeadCountsFromDisk` (line
139) does `readFileSync` of `.beads/issues.jsonl`, which is a full-dump
export that runs 1.5MB / ~1,888 lines for this repo alone, and grows with
every project registered. It then calls `bead-rollup.ts`'s
`collectLinkedBeadIds` (line 322), which does a `readdirSync` of
`openspec/changes/` followed by one `readFileSync` per live proposal's
`tasks.md`, all in a synchronous loop. Both run inside the agent's single Bun
event loop, the same loop that serves `socket-server` hook ingest and every
HTTP route — a sync read blocks all of them for its duration. On top of that,
`startBeadsWatcher`'s per-project setup loop (line 249) fires an unstaggered,
synchronous "best-effort initial recount" for every registered project in one
tight pass at startup, compounding the blocking cost across N projects with no
yield between them.

The sibling `spec-watcher/index.ts` poller in the same daemon hit this exact
class of problem (recurring per-project fan-out work) and already solved it:
`tick()` walks projects in batches of `BATCH_SIZE` (4) with a `BATCH_DELAY_MS`
(200ms) pause between batches, so no single tick monopolizes the event loop.
This plan (a) converts the two hot-path sync IO sites to `node:fs/promises`
(the async API is already imported and used elsewhere in `beads-watcher.ts`
for `stat`/`watch`), and (b) staggers the startup fan-out loop using the same
batch-size/delay shape spec-watcher already established, so the pattern isn't
reinvented. No behavior change to the fail-open semantics — this is purely a
blocking-time and pacing fix.

## Current state

- `apps/agent/src/services/beads-watcher.ts` — the beads filesystem watcher;
  owns `computeBeadCountsFromDisk` and the per-project fan-out loop in
  `startBeadsWatcher`.
- `apps/agent/src/services/bead-rollup.ts` — shared bead-linkage primitives;
  owns `collectLinkedBeadIds`, invoked from `beads-watcher.ts`'s recurring
  recount path.
- `apps/agent/src/routes/beads-unlinked.ts` — the ONLY other caller of
  `collectLinkedBeadIds`; already an `async` request handler, needs exactly
  one `await` added as a mechanical consequence of the signature change (see
  Step 5). Not otherwise in scope.
- `apps/agent/src/services/spec-watcher/index.ts` +
  `apps/agent/src/services/spec-watcher/constants.ts` — the exemplar to
  mirror for both the async-fs pattern and the batch/delay pacing pattern.

### `beads-watcher.ts` today (verified at commit `089e0338`)

Imports (lines 33–34):

```ts
import { existsSync, readFileSync } from "node:fs";
import { stat, watch } from "node:fs/promises";
```

`computeBeadCountsFromDisk` (lines 131–156) — the sync read to convert:

```ts
export function computeBeadCountsFromDisk(
  projectPath: string,
): BeadUnlinkedCounts | null {
  const jsonlPath = join(projectPath, ".beads", ISSUES_FILE);
  if (!existsSync(jsonlPath)) return null;

  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch (err) {
    log.warn({ projectPath, err }, "beads-watcher: read failed; keeping counts");
    return null;
  }

  const beads = parseIssuesJsonl(content);
  if (beads === null) {
    log.warn(
      { projectPath },
      "beads-watcher: malformed issues.jsonl; keeping counts",
    );
    return null;
  }

  const linked = collectLinkedBeadIds(projectPath);
  return deriveUnlinkedCounts(beads, linked);
}
```

Note the file **already** has the async-existence-check idiom you must mirror,
at lines 279–288 (inside `startBeadsWatcher`, checking for `.beads/`):

```ts
      // Missing `.beads/` skips cleanly — no watch, poll fallback still runs.
      try {
        await stat(beadsDir);
      } catch {
        log.debug(
          { project: project.code, beadsDir },
          "beads-watcher: no .beads/ dir; poll-only",
        );
        return;
      }
```

`recount` (lines 228–239) — the sync call site to convert:

```ts
  function recount(project: BeadsWatcherProject): void {
    const counts = computeBeadCountsFromDisk(project.path);
    if (counts === null) return; // fail-open: keep previous
    const prev = lastCounts.get(project.code);
    if (prev && countsEqual(prev, counts)) return; // no change
    lastCounts.set(project.code, counts);
    try {
      sink(project.code, counts);
    } catch (err) {
      log.warn({ project: project.code, err }, "beads-watcher: recount sink threw");
    }
  }
```

The unbatched startup fan-out loop (lines 249–304) — the loop to batch. Every
registered project gets, in one synchronous `for` pass: a `setInterval` poll
timer (line 254), a debounce closure (lines 259–266), and an async IIFE (lines
275–303) whose FIRST action is a best-effort initial `recount(project)` call
(line 277) before anything is awaited:

```ts
  for (const project of projects) {
    const beadsDir = join(project.path, ".beads");

    const pollTimer = setInterval(() => recount(project), pollIntervalMs);
    ac.signal.addEventListener("abort", () => clearInterval(pollTimer), {
      once: true,
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRecount = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recount(project);
      }, debounceMs);
    };
    ac.signal.addEventListener(
      "abort",
      () => {
        if (debounceTimer) clearTimeout(debounceTimer);
      },
      { once: true },
    );

    void (async () => {
      // Best-effort initial recount so the baseline is set before any event.
      recount(project);

      // Missing `.beads/` skips cleanly — no watch, poll fallback still runs.
      try {
        await stat(beadsDir);
      } catch {
        log.debug(
          { project: project.code, beadsDir },
          "beads-watcher: no .beads/ dir; poll-only",
        );
        return;
      }

      try {
        const watcher = watch(beadsDir, { signal: ac.signal });
        for await (const event of watcher) {
          if (event.filename !== ISSUES_FILE) continue;
          scheduleRecount();
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        log.warn(
          { project: project.code, err },
          "beads-watcher: watch terminated (poll fallback continues)",
        );
      }
    })();
  }
```

`startBeadsWatcher`'s public signature (line 209) returns synchronously —
`BeadsWatcherHandle`, not a `Promise`. **This signature must not change** (see
Scope). Callers (e.g. `apps/agent/src/index.ts`, if it wires this watcher at
boot) rely on getting a handle back immediately.

### `bead-rollup.ts` today (verified at commit `089e0338`)

Imports (line 20):

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
```

`collectLinkedBeadIds` (lines 304–333) — the sync loop to convert. Note
`resolveTasksMd` (lines 251–292), just above it in the same file, uses the
identical sync-fs pattern but is **out of scope** — it is called only from
`computeBeadRollup`/`computeRollupsForProject`, both request-time paths
already re-confirmed settled this wave (see Scope):

```ts
export function collectLinkedBeadIds(projectPath: string): Set<string> {
  const linked = new Set<string>();
  const changesRoot = join(projectPath, "openspec", "changes");
  if (!existsSync(changesRoot)) return linked;

  let entries: string[];
  try {
    entries = readdirSync(changesRoot);
  } catch {
    return linked;
  }

  for (const entry of entries) {
    if (entry === "archive" || entry.startsWith(".")) continue;
    const tasksPath = join(changesRoot, entry, "tasks.md");
    if (!existsSync(tasksPath)) continue;
    let body: string;
    try {
      body = readFileSync(tasksPath, "utf8");
    } catch {
      continue;
    }
    const { epicId, featureId, taskIds } = parseBeadMarkers(body);
    if (epicId) linked.add(epicId);
    if (featureId) linked.add(featureId);
    for (const id of taskIds) linked.add(id);
  }

  return linked;
}
```

Its only two callers, both confirmed by a fresh `grep -rn "collectLinkedBeadIds"
apps/agent/src --include='*.ts'`:

1. `apps/agent/src/services/beads-watcher.ts:154` (in scope — the hot 60s
   recurring path this plan exists to fix).
2. `apps/agent/src/routes/beads-unlinked.ts:64` (request-time only — must be
   updated to `await` the call as a mechanical consequence of the signature
   change, but is NOT the perf problem this plan targets).

### The exemplar: `spec-watcher`'s batch/delay pacing (verified at commit `089e0338`)

`apps/agent/src/services/spec-watcher/constants.ts` (lines 10–14) — note its
own header comment says these are **intentionally local, not shared**:

```ts
/** Max projects to poll in one batch before sleeping. */
export const BATCH_SIZE = 4;

/** Delay between batches (ms). */
export const BATCH_DELAY_MS = 200;
```

`apps/agent/src/services/spec-watcher/index.ts`'s `delay` helper (lines
98–101) and its batching loop inside `tick()` (lines 139–162):

```ts
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
...
    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      if (stopped) break;

      const batch = projects.slice(i, i + BATCH_SIZE);
      for (const project of batch) {
        const specs = await _pollProjectSpecs(project.cwd);
        ...
      }

      if (i + BATCH_SIZE < projects.length) {
        await delay(BATCH_DELAY_MS);
      }
    }
```

**Convention note**: because `spec-watcher/constants.ts`'s own docstring says
these constants are deliberately NOT shared across services, do **not**
import `BATCH_SIZE`/`BATCH_DELAY_MS` from `spec-watcher/constants.ts` into
`beads-watcher.ts`. Instead, declare the same two constants (same names, same
values: `4` and `200`) locally in `beads-watcher.ts`, next to the existing
`DEBOUNCE_MS`/`POLL_INTERVAL_MS` constants (lines 49–51). This mirrors the
convention (name + value + shape of use), it does not create a cross-service
import.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (agent) | `pnpm --filter @nexus/agent typecheck` | exit 0, no errors |
| Scoped tests | `bun test apps/agent/src/services/beads-watcher.test.ts apps/agent/src/services/bead-rollup.test.ts apps/agent/src/routes/beads-unlinked.test.ts` | all pass |
| Full test gate | `bun test` | exit 0, all pass (repo's `e2e` gate) |
| Confirm no sync fs remains in scope | `grep -n "readFileSync\|readdirSync\|existsSync" apps/agent/src/services/beads-watcher.ts apps/agent/src/services/bead-rollup.ts` | only matches inside `resolveTasksMd` (bead-rollup.ts lines ~251-292) remain — see Scope |

These are the exact gate commands from `.claude/project.toml` `[stack.gates]`
(`api = "pnpm --filter @nexus/agent typecheck"`, `e2e = "bun test"`) — do not
substitute `tsc` directly or a different test runner.

## Scope

**In scope** (the only files you should modify):
- `apps/agent/src/services/beads-watcher.ts`
- `apps/agent/src/services/beads-watcher.test.ts`
- `apps/agent/src/services/bead-rollup.ts` (ONLY `collectLinkedBeadIds` — do
  not touch `resolveTasksMd` or any other function in this file)
- `apps/agent/src/services/bead-rollup.test.ts` (ONLY the
  `collectLinkedBeadIds` test — do not touch other describe blocks)
- `apps/agent/src/routes/beads-unlinked.ts` (ONLY line 64, adding `await` —
  mechanical consequence of the `collectLinkedBeadIds` signature change, not
  a new feature)

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/services/bead-rollup.ts`'s `resolveTasksMd` (lines
  251–292) and its sync `existsSync`/`readFileSync`/`readdirSync` calls — used
  only by `computeBeadRollup`/`computeRollupsForProject`, both request-time
  paths, already re-confirmed settled this wave (see `settled_context` below).
  Converting it is a different, un-briefed change.
- `apps/agent/src/routes/specs.ts`, `apps/agent/src/routes/specs/handlers-status.ts`,
  `apps/agent/src/services/statusline-usage-file.ts`,
  `apps/agent/src/services/apns-sender.ts`, `apps/nexus-emit/**`,
  `next.config.ts` — all reconfirmed false positives / negligible this wave
  for this seam (`perf-sync-io`). Do not touch.
- `apps/agent/src/services/spec-watcher/**` — read-only exemplar for this
  plan. Do not edit it; do not import its constants (see the Convention note
  above).
- `startBeadsWatcher`'s public function signature and `BeadsWatcherHandle`
  interface — must remain synchronous-returning. Do not make
  `startBeadsWatcher` itself `async` or change its return type to a
  `Promise`.
- Any change to the fail-open contract: a missing `.beads/issues.jsonl`, a
  read error, or malformed JSONL must still resolve to `null` with the exact
  same logging behavior (log on read-error / malformed-JSONL, no log on
  missing file) as today. Do not add new error paths or change what gets
  logged.

## Git workflow

- Branch: work directly on the current branch (this repo's convention per
  `.claude/project.toml` `[git] push = "direct"` — no feature branch, no PR).
- Commit message style (conventional commits, matches `git log`):
  `fix(agent): convert beads-watcher/bead-rollup hot-path IO to async fs and batch startup fan-out`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Convert `bead-rollup.ts`'s `collectLinkedBeadIds` to async fs

In `apps/agent/src/services/bead-rollup.ts`:

1. Change the import at line 20 from:
   ```ts
   import { existsSync, readFileSync, readdirSync } from "node:fs";
   ```
   to (keep `existsSync` — it's still used by `resolveTasksMd`, which stays
   sync and out of scope; add the promise-based `readdir`/`readFile`):
   ```ts
   import { existsSync } from "node:fs";
   import { readdir, readFile } from "node:fs/promises";
   ```
2. Change `collectLinkedBeadIds`'s signature from
   `export function collectLinkedBeadIds(projectPath: string): Set<string>`
   to `export async function collectLinkedBeadIds(projectPath: string): Promise<Set<string>>`.
3. Replace the body's sync calls with async equivalents, preserving every
   fail-open branch exactly:
   - `entries = readdirSync(changesRoot)` inside its `try` → `entries = await readdir(changesRoot)`.
   - Inside the `for (const entry of entries)` loop: keep the `existsSync(tasksPath)`
     early-continue as-is (a cheap stat, not the hot-path 1.5MB-scale cost this
     plan targets), but change `body = readFileSync(tasksPath, "utf8")` inside
     its `try` to `body = await readFile(tasksPath, "utf8")`.
   - Every existing `catch { continue; }` / `catch { return linked; }` branch
     stays exactly as-is — only the awaited call changes, not the control flow.

**Verify**: `pnpm --filter @nexus/agent typecheck` → will still show errors
from callers not yet updated (expected at this point — proceed to Step 2/3
before re-running typecheck for a clean pass).

### Step 2: Update `collectLinkedBeadIds`'s two callers

1. `apps/agent/src/services/beads-watcher.ts:154` — inside
   `computeBeadCountsFromDisk` (converted in Step 3), change
   `const linked = collectLinkedBeadIds(projectPath);` to
   `const linked = await collectLinkedBeadIds(projectPath);`. (Do this as part
   of Step 3's rewrite of the whole function — listed here so you don't miss
   it if editing out of order.)
2. `apps/agent/src/routes/beads-unlinked.ts:64` — this function
   (`handleGetUnlinkedBeads`) is already `async`. Change
   `const linked = collectLinkedBeadIds(proj.path);` to
   `const linked = await collectLinkedBeadIds(proj.path);`. No other change
   to this file.

**Verify**: `grep -n "collectLinkedBeadIds(" apps/agent/src/services/beads-watcher.ts apps/agent/src/routes/beads-unlinked.ts` →
both matches show `await collectLinkedBeadIds(`.

### Step 3: Convert `beads-watcher.ts`'s `computeBeadCountsFromDisk` to async fs

In `apps/agent/src/services/beads-watcher.ts`:

1. Change the import at lines 33–34 from:
   ```ts
   import { existsSync, readFileSync } from "node:fs";
   import { stat, watch } from "node:fs/promises";
   ```
   to:
   ```ts
   import { stat, watch, readFile } from "node:fs/promises";
   ```
   (`existsSync`/`readFileSync` are no longer used anywhere in this file after
   this step — do not leave the `node:fs` import in place.)
2. Change `computeBeadCountsFromDisk`'s signature from
   `export function computeBeadCountsFromDisk(projectPath: string): BeadUnlinkedCounts | null`
   to `export async function computeBeadCountsFromDisk(projectPath: string): Promise<BeadUnlinkedCounts | null>`.
3. Replace the existence check + read with the `stat`-based try/catch idiom
   this same file already uses at lines 279–288 (quoted in "Current state"
   above), merging the "missing file" and "read error" cases into one
   sequence but preserving the exact same observable outcomes (no log for a
   missing file; a `log.warn` for any other read failure):

   ```ts
   export async function computeBeadCountsFromDisk(
     projectPath: string,
   ): Promise<BeadUnlinkedCounts | null> {
     const jsonlPath = join(projectPath, ".beads", ISSUES_FILE);

     try {
       await stat(jsonlPath);
     } catch {
       return null; // missing file — fail-open, no log (matches today's existsSync branch)
     }

     let content: string;
     try {
       content = await readFile(jsonlPath, "utf8");
     } catch (err) {
       log.warn({ projectPath, err }, "beads-watcher: read failed; keeping counts");
       return null;
     }

     const beads = parseIssuesJsonl(content);
     if (beads === null) {
       log.warn(
         { projectPath },
         "beads-watcher: malformed issues.jsonl; keeping counts",
       );
       return null;
     }

     const linked = await collectLinkedBeadIds(projectPath);
     return deriveUnlinkedCounts(beads, linked);
   }
   ```

**Verify**: `pnpm --filter @nexus/agent typecheck` → will still show errors
from `recount`'s call site (expected — fixed in Step 4).

### Step 4: Make `recount` async and update its three call sites

In `apps/agent/src/services/beads-watcher.ts`, inside `startBeadsWatcher`:

1. Change `recount` (lines 228–239) from a sync `function recount(...): void`
   to `async function recount(project: BeadsWatcherProject): Promise<void>`,
   and `await` the now-async `computeBeadCountsFromDisk` call:
   ```ts
   async function recount(project: BeadsWatcherProject): Promise<void> {
     const counts = await computeBeadCountsFromDisk(project.path);
     if (counts === null) return; // fail-open: keep previous
     const prev = lastCounts.get(project.code);
     if (prev && countsEqual(prev, counts)) return; // no change
     lastCounts.set(project.code, counts);
     try {
       sink(project.code, counts);
     } catch (err) {
       log.warn({ project: project.code, err }, "beads-watcher: recount sink threw");
     }
   }
   ```
2. The poll-timer call site (line 254) is a plain (non-async) `setInterval`
   callback. Change:
   ```ts
   const pollTimer = setInterval(() => recount(project), pollIntervalMs);
   ```
   to a fire-and-forget form matching this file's existing idiom at line 219
   (`void recordProjectStatusFromBeads(...).catch((err) => { log.warn(...); })`):
   ```ts
   const pollTimer = setInterval(() => {
     void recount(project).catch((err) => {
       log.warn({ project: project.code, err }, "beads-watcher: poll recount failed");
     });
   }, pollIntervalMs);
   ```
3. The debounce-timeout call site (inside `scheduleRecount`, lines 262–265).
   Change:
   ```ts
   debounceTimer = setTimeout(() => {
     debounceTimer = null;
     recount(project);
   }, debounceMs);
   ```
   to:
   ```ts
   debounceTimer = setTimeout(() => {
     debounceTimer = null;
     void recount(project).catch((err) => {
       log.warn({ project: project.code, err }, "beads-watcher: debounced recount failed");
     });
   }, debounceMs);
   ```
4. The startup-IIFE call site (line 277, "Best-effort initial recount") is
   already inside an `async` IIFE. Change:
   ```ts
       // Best-effort initial recount so the baseline is set before any event.
       recount(project);
   ```
   to:
   ```ts
       // Best-effort initial recount so the baseline is set before any event.
       await recount(project);
   ```
   (This preserves today's ordering guarantee — the initial recount completes
   before the `.beads/` existence check that follows it — without blocking the
   event loop synchronously the way the sync version did.)

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0, no errors (this
is the first point in the sequence where the whole file should typecheck
clean).

### Step 5: Batch the startup fan-out loop

In `apps/agent/src/services/beads-watcher.ts`:

1. Add two local constants next to the existing `DEBOUNCE_MS`/`POLL_INTERVAL_MS`
   (lines 49–51), matching `spec-watcher/constants.ts`'s values exactly (see
   the Convention note in "Current state" — do NOT import them):
   ```ts
   const DEBOUNCE_MS = 300;
   const POLL_INTERVAL_MS = 60_000;
   const ISSUES_FILE = "issues.jsonl";
   /** Max projects to set up in one batch before pausing (mirrors spec-watcher/constants.ts). */
   const BATCH_SIZE = 4;
   /** Delay between setup batches (ms; mirrors spec-watcher/constants.ts). */
   const BATCH_DELAY_MS = 200;
   ```
2. Add a `delay` helper near the top-level function declarations (mirroring
   `spec-watcher/index.ts` lines 98–101 exactly):
   ```ts
   function delay(ms: number): Promise<void> {
     return new Promise((resolve) => setTimeout(resolve, ms));
   }
   ```
3. Extract the per-project body of the `for (const project of projects)` loop
   (lines 249–304 in "Current state" above — everything from
   `const beadsDir = join(...)` through the closing `})();` of the async IIFE)
   into a local function `setupProject(project: BeadsWatcherProject): void`
   that takes no other parameters (it closes over `ac`, `pollIntervalMs`,
   `debounceMs`, and `recount` exactly as the inline loop body did — no
   signature changes needed beyond `project`).
4. Replace the loop itself with a batched, staggered driver that still lets
   `startBeadsWatcher` return its handle synchronously (do NOT make
   `startBeadsWatcher` itself `async` — see Scope). Fire the batching as a
   detached async IIFE, mirroring this file's existing `void (async () => {...})()`
   idiom and `tick()`'s batch-loop shape from `spec-watcher/index.ts`:
   ```ts
   void (async () => {
     for (let i = 0; i < projects.length; i += BATCH_SIZE) {
       if (ac.signal.aborted) return;
       const batch = projects.slice(i, i + BATCH_SIZE);
       for (const project of batch) {
         setupProject(project);
       }
       if (i + BATCH_SIZE < projects.length) {
         await delay(BATCH_DELAY_MS);
       }
     }
   })();
   ```
5. Keep the `log.info({ projectCount: projects.length, ... }, "beads-watcher started")`
   call and the returned `{ stop() {...} }` handle exactly where they are today
   (immediately after the loop, before the function returns) — they must still
   run synchronously on the initial call to `startBeadsWatcher`, independent of
   how many batches the detached IIFE above still has left to process.

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0, no errors.

### Step 6: Update the two existing unit tests for the new async signatures

In `apps/agent/src/services/beads-watcher.test.ts`:

1. Line 217–220 — change:
   ```ts
   test("computeBeadCountsFromDisk returns null when .beads/ is absent", () => {
     const proj = track(makeTempProject()); // no .beads
     expect(computeBeadCountsFromDisk(proj)).toBeNull();
   });
   ```
   to:
   ```ts
   test("computeBeadCountsFromDisk returns null when .beads/ is absent", async () => {
     const proj = track(makeTempProject()); // no .beads
     expect(await computeBeadCountsFromDisk(proj)).toBeNull();
   });
   ```
2. Line 266–273 — change:
   ```ts
   test("computeBeadCountsFromDisk returns null on malformed issues.jsonl", () => {
     const proj = track(makeTempProject());
     const beadsDir = join(proj, ".beads");
     mkdirSync(beadsDir, { recursive: true });
     // Truncated mid-write line → whole read is fail-open null.
     writeFileSync(join(beadsDir, "issues.jsonl"), '{"id":"b1","stat');
     expect(computeBeadCountsFromDisk(proj)).toBeNull();
   });
   ```
   to the same shape with `async () => { ... expect(await computeBeadCountsFromDisk(proj)).toBeNull(); }`.

In `apps/agent/src/services/bead-rollup.test.ts`:

3. Lines 242–265 — change:
   ```ts
   it("unions ids across live proposals and skips archive/", () => {
     const root = makeProject({ ... });
     try {
       const linked = collectLinkedBeadIds(root);
       ...
     } finally {
       rmSync(root, { recursive: true, force: true });
     }
   });
   ```
   to `async () => { ... const linked = await collectLinkedBeadIds(root); ... }`
   (only the callback becomes `async` and the one call gets `await` — the
   fixture setup, assertions, and `finally` cleanup are unchanged).

**Verify**: `bun test apps/agent/src/services/beads-watcher.test.ts apps/agent/src/services/bead-rollup.test.ts apps/agent/src/routes/beads-unlinked.test.ts` →
all tests pass, 0 failures.

## Test plan

- No NEW test cases are required — this plan is a mechanical sync-to-async
  conversion plus a pacing change, and the existing coverage (per
  `beads-watcher.test.ts`'s own header comment, six seams: debounce, poll
  fallback, missing `.beads/`, malformed JSONL, derivation parity,
  BeadTransition emission) already exercises every fail-open branch this plan
  touches. The two tests updated in Step 6 confirm the async signatures
  behave identically to the sync originals for the missing-file and
  malformed-JSONL cases; the poll-fallback and debounce tests
  (`beads-watcher.test.ts` describe blocks 1 and 2, above line 217) exercise
  `recount` end-to-end through the timer paths converted in Step 4 and
  implicitly validate the batching change in Step 5 still lets a poll-only
  project (no `.beads/` dir) produce recounts on schedule.
- Structural pattern to mirror for any new test you find yourself needing:
  `apps/agent/src/services/beads-watcher.test.ts`'s existing
  `describe("beads-watcher missing .beads", ...)` block (lines 216–252) — it
  already shows the `startTracked(...)` + `sleep(...)` + assert-on-`calls[]`
  pattern used for every async-timer-driven case in this file.
- Verification: `bun test` → exit 0, all pass (the repo's `e2e` gate).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] `bun test` exits 0, all pass
- [ ] `grep -n "readFileSync\|readdirSync\|existsSync" apps/agent/src/services/beads-watcher.ts` returns NO matches (all converted or removed)
- [ ] `grep -n "readFileSync\|readdirSync" apps/agent/src/services/bead-rollup.ts` returns matches ONLY inside `resolveTasksMd` (lines ~251–292) — `collectLinkedBeadIds` shows none
- [ ] `grep -n "BATCH_SIZE\|BATCH_DELAY_MS" apps/agent/src/services/beads-watcher.ts` shows the two new local constants (not an import from `spec-watcher/constants.ts`)
- [ ] `grep -n "collectLinkedBeadIds(" apps/agent/src/routes/beads-unlinked.ts` shows the call preceded by `await`
- [ ] `git status` shows changes ONLY in: `apps/agent/src/services/beads-watcher.ts`, `apps/agent/src/services/beads-watcher.test.ts`, `apps/agent/src/services/bead-rollup.ts`, `apps/agent/src/services/bead-rollup.test.ts`, `apps/agent/src/routes/beads-unlinked.ts`
- [ ] `plans/README.md` status row for plan 035 updated (if that file exists and you own it — see executor instructions header)

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited line numbers in "Current state" doesn't match what
  you find in the live file (the codebase has drifted since this plan was
  written at commit `089e0338`) — re-run the drift-check diff at the top of
  this file first.
- `startBeadsWatcher`'s public return type would need to change to a
  `Promise` to make a step work — that means the batching approach in Step 5
  doesn't fit as designed; stop rather than changing the public signature.
- Any existing test in `beads-watcher.test.ts` or `bead-rollup.test.ts`
  outside the two/one you were told to touch in Step 6 starts failing —
  that means a behavior change leaked beyond the sync→async mechanism swap.
- You find a THIRD caller of `collectLinkedBeadIds` beyond
  `beads-watcher.ts:154` and `beads-unlinked.ts:64` (re-run
  `grep -rn "collectLinkedBeadIds" apps/agent/src --include='*.ts'` to
  check) — the scope boundary above assumes exactly two callers.
- `pnpm --filter @nexus/agent typecheck` or `bun test` fails twice in a row
  after a reasonable fix attempt at the same step.

## Maintenance notes

- If a future change adds a third caller of `collectLinkedBeadIds`, it now
  must `await` it — this is a permanent signature change, not a temporary
  shim.
- If `beads-watcher.ts` grows to poll significantly more projects than the
  current fleet size, revisit whether `BATCH_SIZE=4`/`BATCH_DELAY_MS=200`
  (copied from `spec-watcher`'s tuning) is still the right pacing for this
  watcher's own IO profile (per-project payload here is a single
  `issues.jsonl`, which scales differently than spec-watcher's
  `openspec list` subprocess spawn) — this plan did not re-derive the
  constants from beads-watcher's own load characteristics, it reused
  spec-watcher's values as a starting point per the evidence's explicit
  instruction to reuse the exact convention.
- A reviewer should scrutinize: (1) that the "missing file" branch in the
  rewritten `computeBeadCountsFromDisk` (Step 3) truly never logs — a stray
  `log.warn` there would be a silent behavior change under normal operation
  (every project without `.beads/` would start spamming logs every 60s);
  (2) that Step 5's batching IIFE still lets `startBeadsWatcher` return its
  handle before any batch has necessarily finished — `ac`, `lastCounts`, and
  the returned `stop()` closure must all be safe to use immediately even
  while later batches are still pending.
- Explicitly deferred out of this plan: converting `resolveTasksMd`'s sync fs
  calls in the same `bead-rollup.ts` file. It shares the sync-IO shape but is
  called only from request-time paths (`computeBeadRollup`,
  `computeRollupsForProject`), which this wave's audit re-confirmed settled
  (`routes/specs.ts` + `routes/specs/handlers-status.ts` request-time-only
  reasoning). If a future audit flags `resolveTasksMd` specifically, that is
  a new, separate plan — do not fold it into this one after the fact.
