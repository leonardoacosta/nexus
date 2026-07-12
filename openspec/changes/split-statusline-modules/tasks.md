<!-- beads:epic:nx-4n8co -->
<!-- beads:feature:nx-t4hvs -->

# Tasks — split-statusline-modules

Full step-by-step detail, exact code excerpts, the complete Module Map (target file -> source
sections -> exported symbols), and STOP conditions live in `plans/031-statusline-module-split.md`.
Each task cites its source step. **Steps run strictly in order** — each step's shim re-export
pattern depends on the previous step's state, and gates must stay green after every single step
(not just at the end).

## API Batch

- [x] 0.1 Baseline + structural drift check: record the live `bun test` pass count as N (>= 113), [beads:nx-pzpnw]
      the live `export` count in `index.ts` as E, confirm every `// --` section marker from the
      plan's Current-state map still exists, and confirm every named symbol in the Module Map is
      still findable via grep. Any failure or missing marker/symbol is a STOP condition — report,
      do not improvise past it. (plans/031 Step 1)
      Evidence: `bun test` → 127 pass / 0 fail (N=127). `export` count in index.ts → E=25.
      All 19 `// ──` section markers present, matching plan's Current-state map (line numbers
      shifted, no missing/new sections). All Module Map symbols (cache-io/types/project/render/
      usage/context-guard/session-context/speed/agent-lines/contract) confirmed present via
      `\<name\>` word-boundary scan. No STOP condition.
- [x] 1.1 Create `packages/statusline-contract` (types-only, zero-dependency workspace package): [beads:nx-b9gd1]
      `package.json` (exact shape in plans/031 Step 2), `tsconfig.json` (copy
      `packages/db/tsconfig.json` verbatim), `src/index.ts` exporting `UsagePeriod`,
      `UsageResponse`, `CachedUsage` (moved verbatim from `index.ts:122-135` at plan-authoring
      time — read the live tree, the exact line numbers will have shifted since 025/026/027
      landed) with a doc header naming the wire contract's writer/reader/external-consumer
      (cc-tmux's `usage.py`). (plans/031 Step 2)
      Evidence: `pnpm --filter @nexus/statusline-contract typecheck` → exit 0, no output.
      Commit `bfe51ff2`.
- [x] 1.2 Add `"@nexus/statusline-contract": "workspace:*"` to `apps/agent/package.json` [beads:nx-a2c16]
      dependencies; in `apps/agent/src/services/statusline-usage-file.ts`, delete the local
      `UsagePeriod`/`UsageResponse`/`CachedUsage` interfaces, import them from
      `@nexus/statusline-contract` instead, and reword the header comment to point at the
      package rather than the statusline file path. Run `pnpm install`. Verify:
      `pnpm --filter @nexus/agent typecheck` exit 0; `grep -c "interface CachedUsage"
      apps/agent/src/services/statusline-usage-file.ts` → `0`. (plans/031 Step 2)
      Evidence: `pnpm install` → exit 0 (9 workspace projects, package linked).
      `grep -c "interface CachedUsage" statusline-usage-file.ts` → `0`.
      `pnpm --filter @nexus/agent typecheck` → FAILS with 2 pre-existing errors unrelated to
      this change: `credentials.test.ts(20,26)` duplicate `initCredentialRoutes` import (a
      pre-existing bug in that test file's import list, last touched by unrelated merge
      `ae2e33fe`) and `version-builder.ts(19)` `Cannot find module '../version.gen'` (a
      build-time-generated file that only exists after `bun scripts/gen-version.ts` runs, not
      present in this checkout). `git status` confirms only `package.json` +
      `statusline-usage-file.ts` + `pnpm-lock.yaml` are dirty — neither failing file was touched
      by this task, and neither error mentions `CachedUsage`/`UsagePeriod`/`UsageResponse` or the
      new import. Reported verbatim per STOP-condition discipline; not improvised past. Commit
      `e4495709`.

## UI Batch

- [x] 2.1 Create `apps/nexus-statusline/src/cache-io.ts` (exact content in plans/031 Step 3): [beads:nx-8ruid]
      `nowSecs`, `STATE_DIR`, `statePath`, `readJsonCache<T>` (fail-soft read+parse+optional
      type-guard validate), `writeJsonAtomic` (tmp-sibling + 0o600 + rename, fail-soft). Inspect
      the three live write sites first — if ANY already uses a pid-suffixed tmp name (plan 025
      may have landed this), use the pid-suffixed form in `writeJsonAtomic` everywhere; note any
      disagreement in the completion report. Move `nowSecs` here, delete it from `index.ts`,
      import it back temporarily so there is exactly one definition. (plans/031 Step 3)
      Evidence: all three live JSON-cache write sites (`defaultWriteSnapshot`, the inline
      `writeSessionContext` block, `defaultWriteSpeedCache`) used plain `${path}.tmp` — no pid
      suffix, no disagreement. `bun test` → 127 pass / 0 fail (N held). `pnpm --filter
      @nexus/statusline typecheck` → exit 0. Commit `b0e675c2`.
- [x] 2.2 Create `apps/nexus-statusline/src/cache-io.test.ts` — 6 cases: round-trip write+read [beads:nx-h0lbt]
      (no validator), missing-path read → null, corrupt-JSON read → null, validator
      reject/accept, write to an unwritable path does not throw, a successful write leaves no
      `.tmp` sibling. Verify: `bun test` in the package → 0 fail, pass count == N + 6 (record as
      N', the invariant for every later step). (plans/031 Step 3)
      Evidence: `bun test` → 133 pass / 0 fail (N' = 127 + 6 = 133, held as the invariant for
      every subsequent task). Commit `e1685707`.
- [x] 3.1 Extract `types.ts`: move `CcInput`/`StatuslineSession`/`StatuslineResponse`/`GitInfo` [beads:nx-4ct1w]
      into it, re-export the 3 contract types from `@nexus/statusline-contract`, add the
      `@nexus/statusline-contract` workspace dependency to `apps/nexus-statusline/package.json`,
      delete the 3 duplicated interfaces from `index.ts`. Add index.ts shim re-exports for the
      test file's needs (deleted in task 9.x). If `pnpm --filter @nexus/statusline typecheck`
      fails with TS6059/TS6307 (rootDir/composite complaints), rewrite
      `apps/nexus-statusline/tsconfig.json` to match `apps/agent/tsconfig.json`'s shape (drop
      `composite`/`rootDir`). Verify: package typecheck exit 0; `bun test` 0 fail, N' pass.
      (plans/031 Step 4)
      Evidence: `pnpm --filter @nexus/statusline typecheck` → exit 0, no TS6059/TS6307 —
      tsconfig rewrite NOT needed. `bun test` → 133 pass / 0 fail (N' held). Commit `f52583b1`.
- [x] 4.1 Extract `project.ts` (`deriveProjectCode`, the B&B gate section, `getLocalAgentUrl`) and [beads:nx-2vf4w]
      `render.ts` (ANSI consts, model/effort token section, `shortenOutputStyle`,
      `formatCountdown`, session clock, gauge rendering, the renderer section). Move
      `ResolvedContext` into `types.ts` as part of this step (both `render.ts` and the later
      `context-guard.ts` need it, avoiding a cross-module coupling). Add index.ts shims for the
      test file's imports. Verify: `bun test` 0 fail, N' pass; package typecheck exit 0.
      (plans/031 Step 5)
      Evidence: `bun test` → 133 pass / 0 fail (N' held). `pnpm --filter @nexus/statusline
      typecheck` → exit 0. Commit `47ca7466`.
      **Deviation from plan 031 Scope (STOP condition, authorized by team-lead before landing):**
      `index.test.ts:221`'s "[2.10b] renderer source contains no execSync / spawnSync / git
      remote get-url references" test does a raw-source scan hardcoded to read `./index.ts` and
      grep for the literal string `"export function renderStatusline"`. Since renderStatusline's
      real implementation now lives in `render.ts` (index.ts only `export {...} from "./render"`
      re-exports it), that string can never appear in index.ts again under this move — the test
      would fail permanently regardless of implementation detail. Plan 031's Scope section lists
      `index.test.ts` as in-scope ONLY for "the import block :16-40" and separately bans "no
      describe-block reshuffling, no splitting the test file" for anything else, so this was
      flagged as a STOP condition and reported to team-lead rather than improvised past. team-lead
      authorized a one-line fix: repoint the `new URL(...)` target from `"./index.ts"` to
      `"./render.ts"` — the brace-depth body scan and execSync/spawnSync/git-remote assertions are
      otherwise byte-identical. This is not the reshuffling/splitting the Scope section bans, and
      leaving it broken would make every later task's `bun test` gate in this plan unsatisfiable.
- [x] 5.1 Extract `usage.ts` (`FETCH_TIMEOUT_MS`, `PROFILE_CACHE_TTL`, the Anthropic Usage API [beads:nx-3g5j1]
      section). Convert `usageCachePath`/`profileCachePath` to `statePath(...)` calls.
      `getPolledUsage`'s body becomes a `readJsonCache<CachedUsage>` call — preserve any
      staleness-ceiling logic plan 027 added, wrapping the helper's result. Use
      `writeJsonAtomic` for the profile-cache write too (same cache-file class). Verify:
      `bun test` 0 fail, N' pass; package typecheck exit 0. (plans/031 Step 6)
      Evidence: `bun test` → 133 pass / 0 fail (N' held). `pnpm --filter @nexus/statusline
      typecheck` → exit 0. `polledUsageFromCache` (not explicitly named in the plan's Module Map
      symbol list, but the staleness-ceiling logic the plan directs to preserve) moved to
      usage.ts and stays exported + shimmed, since index.test.ts imports it directly. Commit
      `b217f501`.
- [x] 6.1 Extract `context-guard.ts`, `session-context.ts`, `speed.ts` — the cache-io [beads:nx-3twi7]
      consolidation step: collapse each section's private read/write helpers onto
      `readJsonCache`/`writeJsonAtomic`. `writeSessionContext`'s inline tmp+rename block becomes
      a `writeJsonAtomic` call with the payload built EXACTLY as the live code does — do NOT
      alter the null-`usedPct` early-return (settled by design). `gcSessionContext` gains
      `export` and keeps whatever prefix-extension plan 025 added. All three modules' injectable
      dep seams (`CtxResolverDeps`, `SpeedDeps`) stay unchanged. Verify: `bun test` 0 fail, N'
      pass — the dep-seam tests prove the seams survived; the `writeSessionContext` tests hit the
      real fs and prove the consolidated write produces the same file shape. (plans/031 Step 7)
      Evidence: `bun test` → 133 pass / 0 fail (N' held) — dep-seam-injection tests and the
      real-fs `writeSessionContext` tests all pass, proving both the seams and the write shape
      survived. `pnpm --filter @nexus/statusline typecheck` → exit 0. `grep -rn "renameSync"
      src/ --include='*.ts' | grep -v cache-io | grep -v test` → no matches (no stray idiom
      outside cache-io.ts). Also trimmed now-dead imports left over from steps 3.1-6.1
      (writeFileSync/renameSync/readdirSync/unlinkSync, nowSecs, StatuslineSession/UsagePeriod/
      UsageResponse/CachedUsage/ResolvedContext type imports) since this step's move emptied
      their last remaining reference in index.ts. Commit `b2d7c0a9`.
- [ ] 7.1 Extract `agent-lines.ts` (`fetchStatusline`, roadmap pulse, bead/roadmap surface lines, [beads:nx-5jk6b]
      attention guard). Keep the exact `import * as childProcess from "node:child_process"`
      namespace-import idiom and `childProcess.spawn(...)` call form — the spawn-spy tests
      mutate that shared namespace and depend on it. Convert the four inline cache paths to
      `statePath(...)`. Whatever spawn shapes plan 026 left (argv vectors / positional shell
      params) move VERBATIM, no re-hardening. Verify: `bun test` 0 fail, N' pass — specifically
      confirm the roadmap-pulse / SWR spawn-spy describe blocks still pass. (plans/031 Step 8)
- [ ] 8.1 Finalize: replace `index.test.ts`'s single big import block with per-module imports [beads:nx-xvve1]
      (exact mapping in plans/031 Step 9) routing any prereq-plan-added symbols to their Module
      Map home; delete every shim re-export from `index.ts` including the `export type {...}`
      line. `index.ts` retains ONLY: doc header, `readStdinInput`, `getGitStatus` (+ whatever
      import plan 026 left it with), `main`, the `Bun.main` guard, and imports — zero exports.
      Do not reorder or delete anything inside test bodies. Verify: `bun test` 0 fail, N' pass;
      `grep -c '^export ' src/index.ts` → `0`; package typecheck exit 0. (plans/031 Step 9)

## E2E Batch

- [ ] 9.1 Binary proof: `cd apps/nexus-statusline && bun run build` → exit 0. Pipe a fixture [beads:nx-6y74d]
      stdin frame through the real compiled binary (exact command in plans/031 Step 10) and
      confirm the rendered line contains `CTX`, `55%`, `90k/200k`, the project token, and an `O`
      model token — proving the split composes correctly through `bun build --compile`, not just
      through the test runner's module resolution. (plans/031 Step 10)
- [ ] 9.2 Line-count gate: `wc -l apps/nexus-statusline/src/*.ts` — every file <= 500 except [beads:nx-64wri]
      `index.test.ts`. If `render.ts` alone exceeds 500, extract the gauge-rendering block into a
      new `src/gauges.ts` imported by `render.ts`, update the test import for `getBarWidth`, and
      re-run this check. (plans/031 Step 10)
- [ ] 9.3 Full gates: `pnpm typecheck` (exit 0), `pnpm lint` (no new errors in changed files), [beads:nx-xd7y5]
      root `bun test` (no new failures attributable to changed files), `pnpm lint:sql-safety`
      (exit 0 — plan 023 already landed). `git status --short` shows only in-scope files
      modified. Confirm the specific done-criteria greps: zero `interface CachedUsage` outside
      `packages/statusline-contract/`; exactly one `@nexus/statusline-contract` import line in
      `statusline-usage-file.ts`; the `renameSync` grep finds matches only inside `cache-io.ts`
      (plus the one documented exception noted in plans/031 Done criteria, if it applies).
      (plans/031 Step 10)
