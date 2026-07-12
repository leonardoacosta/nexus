<!-- beads:epic:nx-4n8co -->
<!-- beads:feature:nx-vuomk -->

# Tasks — harden-statusline-spawn-and-cache

Full step-by-step detail, exact diffs, and STOP conditions live in
`plans/025-statusline-spawn-hygiene.md` (tasks 1.x), `plans/026-statusline-cache-correctness.md`
(tasks 2.x), and `plans/027-usage-pipeline-test-gap.md` (tasks 3.x). Each task cites its source
step. **Batch 1 (spawn hygiene) MUST land before Batch 2 (cache correctness)** — both edit
`apps/nexus-statusline/src/index.ts` and 2.x's line references assume 1.x's shape.

## UI Batch

- [x] 1.1 Convert `getGitStatus`'s three `execSync` calls to argv-vector `execFileSync` [beads:nx-bzyn0]
      (`git -C <dir> branch --show-current` / `status --porcelain` /
      `rev-list --count @{upstream}..HEAD`); export the function for tests. (plans/025 Step 1)
- [x] 1.2 Convert `getRoadmapPulse`'s `sh -c` spawn to a constant single-quoted script [beads:nx-9vtxd]
      (`PULSE_REFRESH_SCRIPT`) with `PULSE_BIN`/`cachePath` passed as positional shell params
      (`$1`/`$2`), never interpolated into script text. (plans/025 Step 2)
- [x] 1.3 Convert `readCachedAgentJson`'s `sh -c` spawn the same way (`CURL_REFRESH_SCRIPT`, [beads:nx-9whtf]
      `$1`=url, `$2`=cachePath). (plans/025 Step 3)
- [x] 1.4 Add three regression tests: shell-hostile path survives `getGitStatus`; `getRoadmapPulse` [beads:nx-sbxna]
      spawn args carry cachePath positionally, not in script text; `readCachedAgentJson` (via
      `getSpecsLine`) spawn args carry url positionally. Expect 116 pass, 0 fail.
      (plans/025 Step 4)
- [x] 1.5 Narrow `.audit-suppressions.json`'s D4 stanza path to [beads:nx-9hl8m]
      `apps/nexus-statusline/src/index.ts` (from the `src/**` glob) and rewrite the reason to
      describe the actual argv-vector/positional-param spawns; confirm `audit-scan` still reports
      zero D4 findings under the narrowed path. (plans/025 Step 5)
- [x] 1.6 Fix the typo'd allowlist entry in [beads:nx-igxvk]
      `packages/core/src/audit-suppressions.integration.test.ts`
      (`apps/nexus-statuslineline/src/index.ts` → `apps/nexus-statusline/src/index.ts`); confirm
      the integration suite's failure count does not exceed its pre-existing 18-failure baseline.
      (plans/025 Step 6)
- [x] 1.7 Full gates for batch 1: `pnpm typecheck`, `pnpm lint`, [beads:nx-thyhm]
      `bun test apps/nexus-statusline` (116 pass, 0 fail). (plans/025 Step 7)
- [x] 2.1 Fix stale-before-parse in `readCachedAgentJson`: add `stale = true` inside the catch [beads:nx-szpox]
      block so a corrupt-but-fresh cache still triggers a refresh. (plans/026 Step 1)
- [x] 2.2 pid-suffix the two shared refresh tmp filenames (`${cachePath}.$$.tmp`) in [beads:nx-q32bq]
      `getRoadmapPulse` and `readCachedAgentJson`, with `|| rm -f` cleanup on producer failure.
      If batch 1 already reshaped these sites into constant-script + positional-param form, adapt
      inside the constant script per plans/026's "Coordination with plan 025" note. (plans/026
      Step 2)
- [x] 2.3 Extend `gcSessionContext` to all three per-session file-family prefixes [beads:nx-3yw1p]
      (`session-context.`, `statusline-ctx.`, `statusline-speed.`) via an injectable-deps seam
      (`GcDeps`); export it for tests. (plans/026 Step 3)
- [x] 2.4 Add `USAGE_CACHE_MAX_AGE_SECS = 30 * 60` and a pure exported [beads:nx-7irgh]
      `polledUsageFromCache(cached, atSecs)` helper; route `getPolledUsage` through it so a cache
      older than 30 minutes is treated as absent instead of rendering frozen bars. (plans/026
      Step 4)
- [x] 2.5 Reword the `writeSessionContext` docstring's false "independently of the usedPct guard" [beads:nx-seqgo]
      sentence — comment-only, the `usedPct == null` early-return behavior itself is settled by
      design and MUST NOT change. (plans/026 Step 5)
- [x] 2.6 Add the regression tests: corrupt-fresh-cache triggers refresh; both refresh spawns use [beads:nx-n16ua]
      pid-unique tmp paths; `gcSessionContext` prunes all three prefixes honoring the gate + TTL;
      `polledUsageFromCache` staleness boundary (fresh / stale / exact-30-min / missing
      `fetched_at`). Expect >= 9 new passing tests. (plans/026 Step 6)
- [x] 2.7 Full gates for batch 2: `pnpm typecheck`, `pnpm lint`, `bun test apps/nexus-statusline`, [beads:nx-ouezr]
      root `bun test` shows no new failures attributable to the two changed files. (plans/026
      Step 7)

## API Batch

- [x] 3.2 Create `apps/agent/src/services/statusline-usage-file.test.ts` modeled on [beads:nx-pk126]
      `apps/agent/src/services/credential-refresh-job.test.ts` (fake-Db chain stub +
      `active-credential-watcher` `__testing` seam). Cover: no-fingerprint skip, no-row skip,
      never-polled skip, empty-windows skip, happy-path `CachedUsage` shape contract (exact keys,
      0-100 utilization math, ISO `resets_at`, epoch-seconds `fetched_at`), zero/null-limit
      utilization, omitted-window-when-empty, omitted `resets_at` when null, atomic
      tmp+rename with pid suffix + mode 0o600, db-reject fail-soft, write-throw fail-soft. ALL fs
      calls (`writeFileSync`/`renameSync`/`mkdirSync`) spied via restorable `spyOn` and restored
      in `afterEach` — never let a real write through, never `mock.module`. (plans/027 Step 2)

## E2E Batch

- [x] 3.1 Point `apps/nexus-statusline/package.json`'s `test` script at [beads:nx-d96u2]
      `bun test src/index.test.ts` (replacing the `echo 'no tests yet'` stub); verify
      `pnpm --filter @nexus/statusline test` now runs the full suite with 0 fail. (plans/027
      Step 1) — VERIFIED: 127 pass / 0 fail, 240 expect() calls.
- [x] 3.3 Runtime evidence that the new spied suite never touches the real cache file: md5sum [beads:nx-99itu]
      `~/.claude/scripts/state/usage-cache.json` before and after running the new test file — the
      diff MUST be empty (identical or both absent). If the file changed, a spy failed to
      intercept — STOP, do not fall back to `mock.module`. (plans/027 Step 3) — VERIFIED: tight-window
      before/after md5sum identical across two consecutive runs (an initial wide-window check showed
      drift, traced to a concurrent live CC session's own statusline refresh, not the test).
- [x] 3.4 Final gates across all three batches: `pnpm typecheck`, `pnpm lint`, [beads:nx-7szxh]
      `bun test apps/agent/src/services/statusline-usage-file.test.ts` (>= 11 pass, 0 fail),
      `bun test apps/agent/src/services/credential-refresh-job.test.ts` (unperturbed pass/fail
      counts), and confirm `git status` shows modifications only to the in-scope file set across
      all three source plans. (plans/027 Step 4) — VERIFIED: typecheck clean on statusline/core/agent
      (agent's 2 credentials.test.ts TS2300 + db's 2 bun:test-types errors both confirmed pre-existing,
      ancestor of wave base f1ce950e); lint 0 errors (46 pre-existing agent warnings, 1 pre-existing
      statusline warning); statusline-usage-file.test.ts 11 pass/0 fail; credential-refresh-job.test.ts
      6 pass/1 skip/0 fail (unperturbed); git status confined to in-scope files.
