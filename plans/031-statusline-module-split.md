# Plan 031: Split nexus-statusline's 1607-line index.ts along its 5 documented seams, consolidate the triplicated cache-io idiom, and extract a shared CachedUsage contract type

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED you MUST
> append `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row.
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- apps/nexus-statusline/ apps/agent/src/services/statusline-usage-file.ts packages/`
> This plan was written against commit `b7096486` and is **required to run
> AFTER plans 025, 026, and 027**, which edit the same file. Diffs from those
> plans are EXPECTED, not a STOP condition. The real drift gate is Step 1's
> structural check: every section marker and named function in the Module Map
> (below) must still exist in `apps/nexus-statusline/src/index.ts`. A missing
> marker/function, or a brand-new `// ──`-section not listed in the Module
> Map, IS a STOP condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED (large mechanical refactor; zero intended behavior change)
- **Depends on**: plans 025, 026, 027 (hard sequencing — they edit the exact
  line ranges this plan moves; executing 031 first would force them all to
  re-resolve). Also: until plan 023 lands, CI on main is RED solely from a
  `scripts/lint-sql-safety.sh` false positive — this plan's gate is "no new
  failures attributable to changed files", not "CI green".
- **Category**: tech-debt
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

`apps/nexus-statusline/src/index.ts` is 1607 lines and grew +131% in the six
days before this plan was written (639 lines on 2026-05-17 → 696 on 2026-07-05
→ 1607 at `b7096486`), with four feature commits in the final week — every new
statusline feature currently lands in this one file and its 1309-line twin
test file. Its 22 `export` statements exist solely so `index.test.ts` can
import them (the file is the compiled bin entrypoint; nothing else imports
it), meaning the module boundaries already exist in all but file structure —
the file even draws them itself with `// ──` banner comments. Two concrete
costs today: (a) the atomic-write cache idiom is triplicated and the
read-parse-validate cache reader near-triplicated inside the same file, and
(b) `apps/agent/src/services/statusline-usage-file.ts` hand-duplicates the
`CachedUsage`/`UsageResponse`/`UsagePeriod` wire shape (its own doc comment at
line 13-16 says the shape "MUST match `nexus-statusline`'s existing
`CachedUsage` reader byte-for-byte") because no importable boundary exists —
a silent-drift bug waiting to happen on a file two processes share. This plan
splits the file along its own seams, consolidates the cache-io idiom into one
module, and makes the writer/reader shape a single shared type so drift
becomes a typecheck error.

This is the sole structural target approved out of the arch audit: the
B3/B4 god modules that already existed at Wave 1 remain deferred (settled —
do not touch them); `apps/nexus-statusline/src/index.ts` newly crossed the
threshold after the `c67ff12c` verification point and is fair game.

## Current state

All excerpts below are from commit `b7096486`. Plans 025/026/027 will have
changed function INTERNALS (spawn-site shapes, cache lifecycle, tmp naming,
`package.json` test script) by the time you run — that is expected. **Move
the code as it exists in the live tree at execution time**; the excerpts
identify WHICH code moves WHERE, they are not the bytes to re-type.

Repo facts (this is a pnpm + Bun monorepo, NOT a standard T3 repo — no tRPC):

- Workspace globs (`pnpm-workspace.yaml`): `apps/*`, `packages/*`, `tests/e2e`.
- Root scripts (`package.json`): `pnpm typecheck` / `pnpm lint` / `pnpm test`
  all delegate to turbo; `pnpm lint:sql-safety` runs
  `./scripts/lint-sql-safety.sh`. Root `bun test` discovers every `*.test.ts`.
- Tests are `bun:test`, colocated, named `<module>.test.ts`.
- `apps/nexus-statusline` has ZERO workspace dependencies at `b7096486`
  (`package.json` devDeps only: `@types/bun`, `typescript`). Its binary is
  compiled via `bun build src/index.ts --compile --outfile nexus-statusline`
  (the output file is gitignored — `.gitignore` line 95).
- `apps/nexus-statusline/src/index.ts` is the bin entrypoint; `main()` runs
  only under the guard at :1603
  (`if (typeof Bun !== "undefined" && Bun.main === import.meta.path)`), so
  imports from tests never execute `main`.
- At `b7096486` the statusline suite is `113 pass / 0 fail` across 1 file
  (`cd apps/nexus-statusline && bun test`). Prereq plans may have raised the
  count — record the live number in Step 1 and hold it invariant.

### The file being split — section map at `b7096486`

`grep -n '^// ──' apps/nexus-statusline/src/index.ts` yields exactly:

```
64:// ── ANSI colors ───
75:// ── Types ───
142:// ── Config ───
155:// ── Helpers ───
185:// ── Model/effort token ───
244:// ── B&B project gate (radar content) ───
346:// ── Git status (local) ───
387:// ── Agent fetch ───
404:// ── Anthropic Usage API ───
547:// ── Suspicious-zero context guard ───
660:// ── Per-pane session-context harvest (cc-tmux-session-usage-bars) ───
740:// ── tokens/sec via transcript byte-growth (stat-only) ───
852:// ── Roadmap pulse (cc advisor-plans/026) ───
910:// ── Bead / roadmap surface lines (add-bead-proposal-roadmap-surface) ───
1076:// ── Attention guard: foreign high-urgency queue head (add-attention-guard) ───
1183:// ── Session clock: passive elapsed time (add-attention-guard) ───
1202:// ── Gauge rendering ───
1334:// ── Renderer (pure, testable) ───
1551:// ── Main ───
```

### The triplicated atomic-write idiom (consolidation target)

Three sites, identical shape (`.tmp` sibling + `writeFileSync` mode `0o600` +
`renameSync` + swallow-all catch):

`index.ts:589-597` (`defaultWriteSnapshot`):

```ts
function defaultWriteSnapshot(path: string, snap: CtxSnapshot): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // fail-soft — a snapshot write never crashes the render
  }
}
```

`index.ts:692-702` (inline inside `writeSessionContext`) and
`index.ts:783-791` (`defaultWriteSpeedCache`) repeat the same shape.
(Plan 025 may have suffixed the tmp names with `process.pid` — if so, the
consolidated helper keeps the pid-suffixed form.)

Three near-identical read-parse-validate readers: `defaultReadSnapshot`
:578-587 (validates `used_percentage` + `saved_at` are numbers),
`defaultReadSpeedCache` :771-781 (validates `fileSize` + `timestamp`),
`getPolledUsage` :461-469 (same read-parse-fail-soft shape, no field
validation; plan 027 may have added a staleness ceiling — preserve it).

Five one-liner state-path builders all rooted at
`~/.claude/scripts/state/`: `usageCachePath` :421, `profileCachePath` :425,
`ctxSnapshotPath` :571, `sessionContextPath` :662, `speedCachePath` :756 —
plus four inline `join(homedir(), ".claude/scripts/state/...")` cache paths in
`getRoadmapPulse` :871, `getSpecsLine` :1043, `getRoadmapLine` :1062,
`getDriftLine` :1169, and the dir scan in `gcSessionContext` :722.

### The duplicated cross-app contract

`apps/nexus-statusline/src/index.ts:122-135`:

```ts
interface UsagePeriod {
  utilization: number;
  resets_at?: string;
}

interface UsageResponse {
  five_hour?: UsagePeriod;
  seven_day?: UsagePeriod;
}

interface CachedUsage {
  fetched_at: number;
  data: UsageResponse;
}
```

`apps/agent/src/services/statusline-usage-file.ts:38-50` hand-duplicates all
three interfaces under the comment
`/** Matches nexus-statusline's `CachedUsage` reader (apps/nexus-statusline/src/index.ts). */`
and writes the shared file `~/.claude/scripts/state/usage-cache.json`
(`usageCachePath()` at its line 53) that statusline's `getPolledUsage` reads.

### Test-file coupling

`apps/nexus-statusline/src/index.test.ts:16-40` imports 20 functions + 2
types in a single block `from "./index"`. Four tests spy on child_process via
`spyOn(childProcess, "spawn")` (test lines 423, 527, 890, 908) against the
namespace import `import * as childProcess from "node:child_process"` — the
implementation MUST keep the same namespace-import + `childProcess.spawn(...)`
call idiom after the move so those spies keep intercepting.

### tsconfig / package shapes you will mirror

- `apps/nexus-statusline/tsconfig.json` extends `../../tsconfig.base.json`
  with `composite: true, outDir: dist, rootDir: src, types: ["@types/bun"]`.
- `apps/agent/tsconfig.json` (the exemplar for a package that imports
  workspace `.ts` sources) has NO `composite`/`rootDir` — just
  `outDir: dist, types: ["@types/bun"]`.
- `packages/db/package.json` is the exemplar for a source-exporting package:
  `"exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }`,
  scripts `lint: eslint .` + `typecheck: tsc --noEmit` (no local eslint
  config file — the root flat config applies).

## Design decision (made in this plan; maintainer may override before execution)

Where does the shared `CachedUsage` contract live? Two options were surfaced:

- **Option A — type-only export from `packages/core`**: add the three
  interfaces under `packages/core/src/types/`, re-export from core's index,
  add `"@nexus/core": "workspace:*"` to statusline. Pro: no new package.
  Con: statusline (a zero-dep compiled binary) takes a dependency edge on the
  heaviest package in the repo — core's deps include `@nexus/db`, pino, five
  OpenTelemetry packages, zod, protobuf. `import type` is erased at compile
  time so `bun build --compile` stays safe TODAY, but the first person to
  import a VALUE from core into statusline silently bundles that graph into
  the binary.
- **Option B (CHOSEN) — new tiny `packages/statusline-contract`**: a
  types-only, zero-dependency workspace package holding exactly the wire
  shape both processes must agree on. Pro: preserves statusline's zero-heavy-
  deps posture; the compile-safety property is structural (the package has
  nothing to bundle), not a discipline; matches the fleet's schema-only
  "contracts boundary" narrow-waist pattern. Con: one more package worth of
  ceremony (~3 small files).

Execute Option B. If the maintainer overrides to Option A before you start,
Step 2 changes to: create `packages/core/src/types/statusline-usage.ts`,
re-export the three types from `packages/core/src/index.ts`, and use
`@nexus/core` as the import specifier everywhere Step 2/6 says
`@nexus/statusline-contract` — all other steps are identical.

## Module Map (the whole split, in one table)

Every symbol below exists at `b7096486`; move each section verbatim (as it
exists live) into its target file. `index.ts` keeps: the file doc-header
(:1-46), `readStdinInput`, `getGitStatus`, `main`, and the `Bun.main` guard —
nothing else, and ZERO exports when done.

| Target file (new, under `apps/nexus-statusline/src/`) | Source sections/lines at b7096486 | Symbols (exported ones marked *) |
| --- | --- | --- |
| `cache-io.ts` | Helpers :157-159; new code | `nowSecs`*, `STATE_DIR`*, `statePath`*, `readJsonCache`*, `writeJsonAtomic`* |
| `types.ts` | Types :75-120 + GitInfo :348-352 + ResolvedContext :557-560 | `CcInput`*, `StatuslineSession`*, `StatuslineResponse`*, `GitInfo`*, `ResolvedContext`* (moved here so `render.ts` and `context-guard.ts` share it without a cycle — see Step 5); re-exports contract types (see Step 4) |
| `project.ts` | :174-183 + B&B gate :244-303 + :327-344 | `deriveProjectCode`*, `BB_ALLOWLIST`, `isBbProject`*, `stripRadarStale`*, `gatePulseLine`*, `getLocalAgentUrl`* |
| `render.ts` | ANSI :64-73, Model/effort :185-242, :305-325 (`shortenOutputStyle`, `formatCountdown`), Session clock :1183-1200, Gauge rendering :1202-1332, Renderer :1334-1547 | `modelFamilyLetter`*, `modelEffortToken`*, `formatSessionClock`*, `getBarWidth`*, `renderStatusline`*, `RenderDeps`; private: ANSI consts, `shortenOutputStyle`, `formatCountdown`, `renderGauge`, `renderContext`, `parseTimestamp`, `projectUtilization`, `momentumIndicator`, `renderUsageGauge` |
| `usage.ts` | Config :144-145 + Anthropic Usage API :404-545 | `FETCH_TIMEOUT_MS`*, `readAccessToken`, `usageCachePath`, `profileCachePath`, `fetchWithToken`, `getPolledUsage`, `buildStdinUsage`*, `resolveUsage`*, `getAccountDomain`*, `CachedProfile` |
| `context-guard.ts` | Config :148-149 + Suspicious-zero guard :547-658 (minus `ResolvedContext`, which goes to `types.ts`) | `resolveContext`*; private: `CtxSnapshot`, `CtxResolverDeps`, `ctxSnapshotPath`, `defaultReadSnapshot`, `defaultWriteSnapshot`, `defaultStatMtimeMs` |
| `session-context.ts` | Harvest :660-738 | `sessionContextPath`*, `writeSessionContext`*, `gcSessionContext`* (newly exported — `main` calls it cross-module now) |
| `speed.ts` | Config :152-153 + tokens/sec :740-850 | `getSpeed`*; private: `SpeedCache`, `SpeedDeps`, `speedCachePath`, `defaultStatSize`, `defaultReadSpeedCache`, `defaultWriteSpeedCache` |
| `agent-lines.ts` | Agent fetch :387-402 + Roadmap pulse :852-908 + Bead/roadmap lines :910-1074 + Attention guard :1076-1181 | `fetchStatusline`*, `getRoadmapPulse`*, `formatSpecsLine`*, `formatRoadmapLine`*, `getSpecsLine`*, `getRoadmapLine`*, `formatDriftLine`*, `getDriftLine`*; private: wire interfaces, `readCachedAgentJson`, `verdictBand`, TTL consts |
| `packages/statusline-contract/src/index.ts` | Types :122-135 | `UsagePeriod`*, `UsageResponse`*, `CachedUsage`* (types only) |

Internal import graph (acyclic): `types` → contract; `project` → (nothing
internal); `cache-io` → (nothing internal); `render` → `types`, `project`
(`renderStatusline` calls `deriveProjectCode` at :1381), `cache-io`
(`nowSecs` at :1308); `usage` → `types`, `cache-io`; `context-guard` →
`types`, `cache-io`; `session-context` → `cache-io`; `speed` → `cache-io`;
`agent-lines` → `project`, `cache-io`, `types`, `usage` (for
`FETCH_TIMEOUT_MS`); `index` → everything it composes. No cycles.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install / link new package | `pnpm install` | exit 0, lockfile updated |
| Statusline suite | `cd apps/nexus-statusline && bun test` | `0 fail`, pass count == baseline N from Step 1 |
| Statusline typecheck | `pnpm --filter @nexus/statusline typecheck` | exit 0 |
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Repo typecheck | `pnpm typecheck` | exit 0 |
| Repo lint | `pnpm lint` | no NEW errors attributable to changed files |
| SQL-safety lint | `pnpm lint:sql-safety` | exit 0 if plan 023 landed; otherwise only the pre-existing known false positive |
| Full test sweep | `bun test` (repo root) | no new failures attributable to changed files |
| Build binary | `cd apps/nexus-statusline && bun run build` | exit 0, `./nexus-statusline` created |

## Scope

**In scope** (the only files you may modify/create):

- `apps/nexus-statusline/src/index.ts` (shrink to entrypoint)
- `apps/nexus-statusline/src/cache-io.ts` (create)
- `apps/nexus-statusline/src/cache-io.test.ts` (create)
- `apps/nexus-statusline/src/types.ts` (create)
- `apps/nexus-statusline/src/project.ts` (create)
- `apps/nexus-statusline/src/render.ts` (create)
- `apps/nexus-statusline/src/usage.ts` (create)
- `apps/nexus-statusline/src/context-guard.ts` (create)
- `apps/nexus-statusline/src/session-context.ts` (create)
- `apps/nexus-statusline/src/speed.ts` (create)
- `apps/nexus-statusline/src/agent-lines.ts` (create)
- `apps/nexus-statusline/src/index.test.ts` (import block :16-40 ONLY)
- `apps/nexus-statusline/package.json` (add `@nexus/statusline-contract` dep)
- `apps/nexus-statusline/tsconfig.json` (only if TS6059/TS6307 forces the agent-style shape — see Step 6)
- `packages/statusline-contract/package.json`, `tsconfig.json`, `src/index.ts` (create)
- `apps/agent/package.json` (add `@nexus/statusline-contract` dep)
- `apps/agent/src/services/statusline-usage-file.ts` (replace local interfaces with the contract import; update its doc comment lines 13-18 to point at the package)
- `pnpm-lock.yaml` (regenerated by `pnpm install`)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- ANY behavior change inside the moved code. Specifically: the spawn-site
  shapes (plan 026's territory), cache GC / staleness / tmp-naming behavior
  (plans 025/027), and `writeSessionContext`'s null-`usedPct` early-return —
  that guard is SETTLED BY DESIGN (2-of-3 verifiers refuted the contradiction
  claim); move it verbatim, do not "fix" it even if its docstring reads oddly.
- `apps/nexus-statusline/package.json` `"test"` script — plan 025's
  territory; leave whatever value you find.
- `index.test.ts` beyond the import block — no describe-block reshuffling, no
  splitting the test file (allowed to stay >500 lines).
- The six pre-existing >=500-line files elsewhere in the repo (deferred
  Wave-1 class, settled).
- `packages/core/**` (unless the maintainer flipped to Option A),
  `packages/db/**`, `apps/agent/**` beyond the two named files, `deploy/**`,
  cc-tmux's external `usage.py` reader (out of repo — the file FORMAT on disk
  must therefore stay byte-identical).
- Drizzle schema / migrations — nothing here touches the DB; if you think it
  does, you are off-plan. (Repo policy regardless: migration-only, `db:push`
  is banned.)

## Git workflow

- Branch: `advisor/031-statusline-module-split` (matches executed plans 003,
  005, 007, 011, 015 in `plans/README.md`).
- Conventional commits, one per step or logical unit, e.g.
  `refactor(nexus-statusline): extract cache-io module` (repo style per
  `git log`: `feat(nexus-statusline): write model letter into session-context cache`).
- Do NOT push or open a PR unless the operator instructed it.
- Plans execute in worktrees and Leo works directly in
  `~/dev/personal/nexus` — expect `main` to advance mid-execution; do not
  rebase mid-plan, finish then reconcile.

## Steps

### Step 1: Baseline + structural drift check

1. `cd apps/nexus-statusline && bun test` — record the pass count as **N**
   (>= 113). Any failure at baseline = STOP (a prereq plan landed broken or
   is unmerged).
2. `grep -c '^export ' src/index.ts` — record as **E** (22 at `b7096486`;
   prereqs may have shifted it slightly).
3. `grep -n '^// ──' src/index.ts` — every section from the Current-state map
   must appear (line numbers may have shifted). A missing section, or a new
   unlisted `// ──` section, = STOP.
4. For each symbol in the Module Map: `grep -n "function <name>\|interface <name>" src/index.ts`
   finds it. Missing symbol = STOP.

**Verify**: all four checks pass; N and E recorded in your notes.

### Step 2: Create `packages/statusline-contract` and point the agent-side writer at it

Create `packages/statusline-contract/package.json`:

```json
{
  "name": "@nexus/statusline-contract",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

`packages/statusline-contract/tsconfig.json` — copy
`packages/db/tsconfig.json` verbatim (extends base, `composite: true`,
`outDir: dist`, `rootDir: src`, include `src`).

`packages/statusline-contract/src/index.ts` — the three interfaces moved
from `apps/nexus-statusline/src/index.ts:122-135` (exact bodies from the
live tree), each with `export`, plus a doc header stating: this is the wire
contract for `~/.claude/scripts/state/usage-cache.json`, written by
`apps/agent/src/services/statusline-usage-file.ts`, read by
`apps/nexus-statusline` and (externally) cc-tmux's `usage.py`; `utilization`
is a 0-100 percentage; types only — this package must never gain a runtime
dependency or a value export (it is bundled into a `bun build --compile`
binary).

Then:
- `apps/agent/package.json`: add `"@nexus/statusline-contract": "workspace:*"`
  to `dependencies`.
- `apps/agent/src/services/statusline-usage-file.ts`: delete the local
  `UsagePeriod`/`UsageResponse`/`CachedUsage` interfaces (lines 38-50 at
  `b7096486`), add
  `import type { CachedUsage, UsagePeriod, UsageResponse } from "@nexus/statusline-contract";`
  and reword its header comment ("The written shape MUST match...") to point
  at the package instead of the statusline file path.
- `pnpm install`.

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0, and
`grep -c "interface CachedUsage" apps/agent/src/services/statusline-usage-file.ts` → `0`.

### Step 3: Create `cache-io.ts` + its test

Create `apps/nexus-statusline/src/cache-io.ts`:

```ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Shared CC state dir every statusline cache file lives in. */
export const STATE_DIR = join(homedir(), ".claude/scripts/state");

export function statePath(fileName: string): string {
  return join(STATE_DIR, fileName);
}

/**
 * Read + JSON.parse a cache file, optionally shape-validated. Fail-soft:
 * missing / unreadable / unparseable / invalid → null, never throws.
 */
export function readJsonCache<T>(
  path: string,
  validate?: (raw: unknown) => raw is T,
): T | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (validate) return validate(raw) ? raw : null;
    return raw as T;
  } catch {
    return null;
  }
}

/**
 * Atomic cache write: tmp sibling + 0o600 + rename. Fail-soft: a cache
 * write never crashes the render.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  try {
    const tmp = `${path}.tmp`; // keep pid suffix here IF the live sites use one
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // fail-soft
  }
}
```

Tmp-naming rule: inspect the three live write sites first. If ANY uses a
pid-suffixed tmp (`${path}.tmp.${process.pid}` — plan 025 may have landed
this), use the pid-suffixed form in `writeJsonAtomic`; otherwise plain
`.tmp`. If the sites disagree, use the pid-suffixed form everywhere and note
it in your completion report.

Move `nowSecs` here: delete it from `index.ts` and import it there
(temporarily) so there is exactly one definition.

Create `apps/nexus-statusline/src/cache-io.test.ts` (model after the
fs-based tests in `index.test.ts` — `mkdtempSync(join(tmpdir(), ...))`
pattern, `bun:test` imports, cleanup in `afterEach`), covering:
1. `writeJsonAtomic` + `readJsonCache` round-trip (no validator).
2. `readJsonCache` on a missing path → null.
3. `readJsonCache` on corrupt JSON → null.
4. `readJsonCache` with a validator that rejects → null; accepts → value.
5. `writeJsonAtomic` to an unwritable path (e.g. a path whose parent does
   not exist) does not throw.
6. `writeJsonAtomic` leaves no `.tmp` sibling behind on success.

**Verify**: `cd apps/nexus-statusline && bun test` → `0 fail`, pass count
== N + 6 (record the new N' = N + 6 as the invariant for later steps).

### Step 4: Extract `types.ts`, then re-export from `index.ts` (shim pattern)

Migration invariant for Steps 4-8: `index.test.ts` still imports everything
`from "./index"`, so after moving each section OUT of `index.ts`, add a
re-export line in `index.ts` for every symbol the test file or another
module needs, e.g. `export { resolveContext } from "./context-guard";` /
`export type { CcInput } from "./types";`. The shim lines are deleted in
Step 9. Gates must be green after EVERY step.

1. Move `CcInput`, `StatuslineSession`, `StatuslineResponse` (:77-120) and
   `GitInfo` (:348-352) into `src/types.ts`, each `export`ed.
2. In `types.ts` add:
   `export type { UsagePeriod, UsageResponse, CachedUsage } from "@nexus/statusline-contract";`
3. In `apps/nexus-statusline/package.json` add
   `"dependencies": { "@nexus/statusline-contract": "workspace:*" }`, then
   `pnpm install`.
4. Delete the three duplicated interfaces (:122-135) from `index.ts`;
   everything in `index.ts` now imports them from `./types`.
5. `index.ts` keeps its :1549 public type re-export working via the shim:
   `export type { CcInput, GitInfo, StatuslineResponse, UsageResponse } from "./types";`

If `pnpm --filter @nexus/statusline typecheck` now fails with TS6059/TS6307
("not under rootDir" / composite complaints) because the contract package's
`.ts` source is outside `rootDir: src`: rewrite
`apps/nexus-statusline/tsconfig.json` to match `apps/agent/tsconfig.json`'s
shape (drop `composite` and `rootDir`, keep `outDir`, `types`, include/
exclude) — the agent is the in-repo exemplar of a package that typechecks
while importing workspace `.ts` sources.

**Verify**: `pnpm --filter @nexus/statusline typecheck` → exit 0;
`bun test` in the package → `0 fail`, N' pass.

### Step 5: Extract `project.ts` and `render.ts`

`project.ts`: move `deriveProjectCode` (:174-183), the whole B&B gate
section (:246-303: `BB_ALLOWLIST`, `isBbProject`, `stripRadarStale`,
`gatePulseLine`), and `getLocalAgentUrl` (:327-344). Export all except
`BB_ALLOWLIST`.

`render.ts`: move the ANSI consts (:65-73), Model/effort token section
(:187-242), `shortenOutputStyle` (:306-311), `formatCountdown` (:314-325),
Session clock (:1191-1200), the entire Gauge rendering section (:1204-1332),
and the Renderer section (:1336-1547: `RenderDeps` + `renderStatusline`).
As part of this step, also move the `ResolvedContext` interface (:557-560)
into `types.ts` (exported) — `RenderDeps.resolvedContext` needs it now and
`context-guard.ts` will need it in Step 7; hosting it in `types.ts` avoids
any `render` ↔ `context-guard` coupling. `render.ts` imports: `CcInput`,
`GitInfo`, `StatuslineResponse`, `UsageResponse`, `ResolvedContext` from
`./types`; `deriveProjectCode` from `./project` (used at :1381); `nowSecs`
from `./cache-io` (used by `renderUsageGauge` :1308).

Add shim re-exports in `index.ts` for: `modelFamilyLetter`,
`modelEffortToken`, `formatSessionClock`, `getBarWidth`, `renderStatusline`,
`isBbProject`, `stripRadarStale`, `gatePulseLine` (the test file's imports).

**Verify**: `bun test` → `0 fail`, N' pass; package typecheck exit 0.

### Step 6: Extract `usage.ts`

Move `FETCH_TIMEOUT_MS` + `PROFILE_CACHE_TTL` (:144-145) and the whole
Anthropic Usage API section (:406-545). Export `FETCH_TIMEOUT_MS`,
`buildStdinUsage`, `resolveUsage`, `getAccountDomain`; keep the rest
module-private. Convert `usageCachePath`/`profileCachePath` to
`statePath("usage-cache.json")` / `statePath("profile-cache.json")` (from
`./cache-io`). `getPolledUsage`'s body becomes a `readJsonCache<CachedUsage>`
call — PRESERVE any staleness-ceiling logic plan 027 added on top (the
ceiling check stays in `getPolledUsage`, wrapping the helper's result).
`getAccountDomain`'s profile-cache write at :536 stays a direct
`writeFileSync` OR uses `writeJsonAtomic` — use `writeJsonAtomic` (it is the
same 0o600 cache-file class; the audit noted this fourth site reinforces the
helper). Shim re-exports: `buildStdinUsage`, `resolveUsage`.

**Verify**: `bun test` → `0 fail`, N' pass; package typecheck exit 0.

### Step 7: Extract `context-guard.ts`, `session-context.ts`, `speed.ts` (the cache-io consolidation)

For each of the three sections, move the code and collapse its private
read/write helpers onto `cache-io`:

- `context-guard.ts` (:549-658 + consts :148-149): `defaultReadSnapshot`
  becomes `readJsonCache<CtxSnapshot>(path, isCtxSnapshot)` with a type-guard
  validating `used_percentage` and `saved_at` are numbers (exact same checks
  as :581-582); `defaultWriteSnapshot` becomes a call to `writeJsonAtomic`.
  The injectable `CtxResolverDeps` seam is UNCHANGED (tests inject through
  it). `ctxSnapshotPath` uses `statePath(...)`. `ResolvedContext` now lives
  in `types.ts` (Step 5); import it.
- `session-context.ts` (:662-738): `writeSessionContext`'s inline tmp+rename
  block (:692-702) becomes a `writeJsonAtomic(path, payload)` call — build
  the payload object exactly as the live code does (do NOT alter the
  null-`usedPct` early-return or the model-letter behavior, whatever state
  plan 027 left them in). `gcSessionContext` uses `STATE_DIR` and gains
  `export` (and keep any prefix-extension plan 025 added). `sessionContextPath`
  uses `statePath(...)`.
- `speed.ts` (:742-850 + consts :152-153): `defaultReadSpeedCache` →
  `readJsonCache<SpeedCache>(path, isSpeedCache)` (checks `fileSize` +
  `timestamp` numbers, same as :774); `defaultWriteSpeedCache` →
  `writeJsonAtomic`. `SpeedDeps` seam unchanged. `speedCachePath` uses
  `statePath(...)`.

Shim re-exports in `index.ts`: `resolveContext`, `sessionContextPath`,
`writeSessionContext`, `getSpeed`.

**Verify**: `bun test` → `0 fail`, N' pass — the context-guard/speed tests
inject fake readers/writers through the dep seams, so they prove the seams
survived; the `writeSessionContext` tests hit the real fs and prove the
consolidated write produces the same file shape.

### Step 8: Extract `agent-lines.ts`

Move: `fetchStatusline` (:389-402), Roadmap pulse section (:854-908), Bead/
roadmap surface lines (:912-1074), Attention guard (:1078-1181). Imports:
`import * as childProcess from "node:child_process";` — KEEP this exact
namespace-import idiom and the `childProcess.spawn(...)` call form (the four
`spyOn(childProcess, "spawn")` tests depend on mutating that shared
namespace); `deriveProjectCode`, `isBbProject`, `gatePulseLine` from
`./project`; `statePath` from `./cache-io`; `StatuslineResponse` from
`./types`; `FETCH_TIMEOUT_MS` from `./usage`. Convert the four inline cache
paths (:871, :1043, :1062, :1169) to `statePath(...)`. Whatever spawn shapes
plan 026 left (argv vectors / positional shell params) move VERBATIM.

Shim re-exports: `getRoadmapPulse`, `formatSpecsLine`, `formatRoadmapLine`,
`getSpecsLine`, `getRoadmapLine`, `getDriftLine`, `formatDriftLine`.

**Verify**: `bun test` → `0 fail`, N' pass — specifically the spawn-spy tests
(grep the run output for the roadmap-pulse / SWR describe blocks) still pass.

### Step 9: Finalize — rewrite the test import block, strip the shim, shrink `index.ts`

1. Replace `index.test.ts`'s single import block (:16-40 at `b7096486`) with
   per-module imports:

   ```ts
   import { renderStatusline, modelEffortToken, modelFamilyLetter, formatSessionClock, getBarWidth } from "./render";
   import { isBbProject, gatePulseLine, stripRadarStale } from "./project";
   import { getRoadmapPulse, formatSpecsLine, formatRoadmapLine, getSpecsLine, getRoadmapLine, getDriftLine, formatDriftLine } from "./agent-lines";
   import { buildStdinUsage, resolveUsage } from "./usage";
   import { resolveContext } from "./context-guard";
   import { getSpeed } from "./speed";
   import { sessionContextPath, writeSessionContext } from "./session-context";
   import type { CcInput, UsageResponse } from "./types";
   ```

   (If prereq plans added imports to this block, route each added symbol to
   its Module Map home.)
2. Delete every shim re-export from `index.ts`, including the
   `export type {...}` line. `index.ts` retains ONLY: doc header,
   `readStdinInput`, `getGitStatus` (+ its `execSync` import — or whatever
   plan 026 turned it into), `main`, the `Bun.main` guard, and imports.
3. Do not delete or reorder anything inside test bodies.

**Verify**:
- `cd apps/nexus-statusline && bun test` → `0 fail`, N' pass.
- `grep -c '^export ' src/index.ts` → `0`.
- `pnpm --filter @nexus/statusline typecheck` → exit 0.

### Step 10: Binary proof + full gates

1. `cd apps/nexus-statusline && bun run build` → exit 0 (compiles
   `src/index.ts` with all its module imports into the single binary; the
   output `nexus-statusline` is gitignored — leave or delete, never commit).
2. Byte-run a fixture frame through the real binary:

   ```bash
   echo '{"session_id":"plan031-smoke","model":{"id":"claude-opus-4-8","display_name":"Opus"},"workspace":{"project_dir":"'"$PWD"'"},"context_window":{"used_percentage":45,"context_window_size":200000}}' \
     | ./nexus-statusline | sed 's/\x1b\[[0-9;]*m//g'
   ```

   Expected: a non-empty line containing `CTX`, `55%`, and `90k/200k`, plus
   the project token and an `O` model token. (Side effects are normal: it
   writes `~/.claude/scripts/state/statusline-ctx.plan031-smoke.json` and may
   detach a background roadmap-pulse/curl refresh — this binary already runs
   on every prompt render on this machine.)
3. Line-count gate:

   ```bash
   wc -l apps/nexus-statusline/src/*.ts | sort -n
   ```

   Expected: every file <= 500 EXCEPT `index.test.ts`. If `render.ts` alone
   exceeds 500 (it lands ~460 at `b7096486` sizes; prereq growth could tip
   it), move the Gauge rendering block (`getBarWidth` through
   `renderUsageGauge`) into a new `src/gauges.ts` imported by `render.ts`,
   update the test import for `getBarWidth`, and re-run this step's checks.
4. Full gates: `pnpm typecheck` (exit 0), `pnpm lint` (no new errors in
   changed files), root `bun test` (no new failures attributable to changed
   files), `pnpm lint:sql-safety` (exit 0 once plan 023 landed).
5. `git status --short` — only in-scope files listed.

## Test plan

- **New tests**: `apps/nexus-statusline/src/cache-io.test.ts` — the six cases
  listed in Step 3 (round-trip, missing file, corrupt JSON, validator
  reject/accept, unwritable path no-throw, no leftover `.tmp`). Model its
  structure after `apps/nexus-statusline/src/index.test.ts` (bun:test,
  `mkdtempSync` temp dirs, `afterEach` cleanup, `describe`/`it` naming).
- **Existing suite as the regression harness**: the 113+ tests in
  `index.test.ts` are the behavioral spec for every moved function; they run
  unmodified (bodies untouched, only the import block rewritten) — passing
  them at count N' after each step IS the proof the split changed nothing.
- **Contract enforcement**: no new test needed — after Step 2 the agent-side
  writer types its payload as the imported `CachedUsage`, so any future shape
  drift is a `pnpm typecheck` failure instead of a silent file-format fork.
- Verification: `cd apps/nexus-statusline && bun test` → `0 fail`,
  `N + 6` pass (where N is the Step-1 baseline).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c '^export ' apps/nexus-statusline/src/index.ts` → `0`
- [ ] The 9 new module files exist under `apps/nexus-statusline/src/` per the Module Map
- [ ] `wc -l apps/nexus-statusline/src/*.ts` — no file > 500 except `index.test.ts`
- [ ] `cd apps/nexus-statusline && bun test` → `0 fail`, pass count == baseline N + 6
- [ ] `grep -rn "renameSync" apps/nexus-statusline/src/ --include='*.ts' | grep -v cache-io | grep -v test` → no matches, with ONE allowed exception: a `renameSync` inside `agent-lines.ts` that prereq plans 025/026 introduced as part of a shell-free SWR refresh (renaming a downloaded/spawned output file on process exit is not the JSON-cache-write idiom and must NOT be forced through `writeJsonAtomic`); if that exception applies, record it in the completion report
- [ ] `grep -c "interface CachedUsage" apps/agent/src/services/statusline-usage-file.ts apps/nexus-statusline/src/*.ts | grep -v ':0'` → only the contract package defines it (zero matches outside `packages/statusline-contract/`)
- [ ] `grep -n "@nexus/statusline-contract" apps/agent/src/services/statusline-usage-file.ts` → 1 import line
- [ ] `cd apps/nexus-statusline && bun run build` → exit 0, and the Step-10 fixture pipe outputs a line containing `CTX` and `55%`
- [ ] `pnpm typecheck` → exit 0; `pnpm lint` + root `bun test` → no new failures attributable to changed files
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated with `spec-impact: ...` per the handoff rule

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 baseline fails: any test failing before you change anything, or a
  Module Map section marker / named function absent from `index.ts` (either
  prereqs 025/026/027 have not landed, or the file drifted past this plan's
  map — e.g. a NEW `// ──` section this plan does not assign a home).
- Plans 025, 026, or 027 show as not-DONE in `plans/README.md` — this plan
  hard-depends on executing after them; running first creates total-overlap
  merge conflicts on the exact lines being moved.
- `bun build --compile` fails after the contract import lands (Step 4/10) —
  the zero-runtime-dep assumption about the contract package would be false.
- The statusline tsconfig fix in Step 4 does not clear the typecheck (two
  attempts) — the workspace-source-import pattern differs from the agent
  exemplar in a way this plan did not anticipate.
- Any step's suite run reports a pass count != N' or any failure, twice,
  after re-checking the move against the Module Map.
- The consolidation appears to require CHANGING behavior (e.g. the three
  atomic-write sites turn out to genuinely differ beyond tmp naming and
  payload shape) — consolidate only what is identical; report the divergence
  instead of normalizing it.
- You find yourself editing a file not on the in-scope list.

## Maintenance notes

- **For the reviewer**: the whole diff should be moves + import rewiring +
  the three collapsed helpers. Scrutinize (1) that `writeSessionContext`'s
  guard semantics are byte-equivalent (settled design — the null-`usedPct`
  early-return must survive verbatim), (2) that the spawn call sites still go
  through the `childProcess` namespace (spy compatibility AND plan 026's
  security shapes preserved), (3) that `usage-cache.json`'s on-disk format is
  unchanged (external reader: cc-tmux `usage.py`).
- **Future statusline features**: land in the owning module, not `index.ts`.
  A new ambient line = `agent-lines.ts` + a `RenderDeps` field; a new cache
  file = `cache-io.statePath` + `readJsonCache`/`writeJsonAtomic`, never a
  fresh inline idiom.
- **Deferred, deliberately**: splitting the 1309-line `index.test.ts` into
  per-module test files (allowed to stay large by this plan's done criteria;
  mechanical follow-up once the module names stabilize); sharing the
  `usage-cache.json` FILENAME as a contract constant (value export — kept
  out to preserve the types-only posture; the path string remains duplicated
  and annotated on both sides); any adoption of `@nexus/core`'s `safeSpawn`
  in statusline (plan 026's decision, not re-opened here).
- **Contract package discipline**: `packages/statusline-contract` must stay
  types-only with zero deps — it is bundled into a compiled binary. If it
  ever needs a value export, that is a design decision for the maintainer,
  not a drive-by.
