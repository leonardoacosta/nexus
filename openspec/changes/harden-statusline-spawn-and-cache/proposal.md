# Harden the statusline binary: spawn hygiene, cache correctness, and real test wiring

## Why

Three sequential, same-file findings from the Wave-3 `/improve:code` audit (2026-07-11, commit
`b7096486`), bundled because they form a dependency chain against
`apps/nexus-statusline/src/index.ts` and must land in order:

1. **Spawn hygiene (security/tech-debt)**: five child-process invocations in
   `apps/nexus-statusline/src/index.ts` assemble shell command strings via template-literal
   interpolation of values derived from the CC stdin payload's `workspace.project_dir` — zero
   sanitization. Exploitability is self-injection-only (P2, not P0), but the pattern is actively
   reproducing (`readCachedAgentJson` is a new-since-baseline copy of the older
   `getRoadmapPulse` template), and the D4 audit suppression covering this file carries a reason
   ("constant-arg git probes with no user input") that is no longer true — meaning new
   shell-string spawn shapes in this file ship invisible to the audit gate. A companion allowlist
   test also has a typo'd path (`nexus-statuslineline`) that would silently stop covering the real
   file the moment the suppression narrows.
2. **Cache lifecycle correctness (bug)**: four defects in the same file's stale-while-revalidate
   cache machinery — a corrupt-but-fresh agent cache suppresses its own refresh (contradicting its
   own catch comment), two detached refresh spawns share a fixed per-project tmp filename so
   concurrent CC sessions can interleave writes and commit corrupt bytes with a fresh mtime, GC
   only prunes one of three per-session file families (the other two accumulate forever), and the
   polled-usage cache has no staleness bound (a dead/undeployed poller renders arbitrarily old
   usage bars indefinitely with no cue).
3. **Test-gate wiring (tests)**: `apps/nexus-statusline/package.json`'s `test` script is still the
   stub `"echo 'no tests yet'"` despite a live 1309-line, 113+-test suite — so `turbo test` /
   `pnpm test` report green for this package without running a single statusline test. Separately,
   the agent's `writeStatuslineUsageFile` — now the SOLE writer of the usage-cache file the
   statusline reads — has zero test coverage anywhere in the repo.

## What Changes

- **Spawn hygiene**: convert the three `execSync` git probes to argv-vector `execFileSync`
  (metacharacters become inert); convert the two `sh -c` template-literal spawns to constant
  scripts with values passed as positional shell parameters (`$1`/`$2`), never interpolated into
  script text. Narrow and re-truthify the D4 suppression reason; fix the typo'd allowlist path.
- **Cache correctness**: fix the stale-before-parse ordering bug (corrupt-but-fresh now correctly
  triggers a refresh); pid-suffix the two shared refresh tmp filenames with failure cleanup;
  extend the GC to all three per-session file-family prefixes; add a 30-minute hard staleness
  bound to the polled-usage cache (omit the segment instead of rendering frozen bars).
- **Test wiring**: point the statusline `test` script at the real suite; add a dedicated
  `writeStatuslineUsageFile` unit suite (fs calls spied, never allowed through — this must never
  touch the operator's live cache file).

## Context

- depends on: none (self-contained chain)
- touches: `apps/nexus-statusline/src/index.ts`, `apps/nexus-statusline/src/index.test.ts`,
  `apps/nexus-statusline/package.json`, `.audit-suppressions.json`,
  `packages/core/src/audit-suppressions.integration.test.ts`,
  `apps/agent/src/services/statusline-usage-file.test.ts` (new)

**Ordering constraint (load-bearing, preserved from the source plans)**: within this proposal,
Batch tasks under 1.x (spawn hygiene) MUST land before 2.x (cache correctness) — both edit the
same file and 2.x's line-number references assume 1.x's shape; 3.x (test wiring) has no hard file
overlap with either but should follow both so it wires in a suite reflecting their state. This
proposal is intentionally scoped to land BEFORE the (separately-considered, not-yet-approved)
statusline module-split — that structural refactor would relocate every line these three batches
cite.

No conflicting soft dependencies: the only other in-flight epic touching this repo area is
`statusline-renderer` itself (already the target capability here); no other unarchived proposal
writes `apps/nexus-statusline/**`.

**Source material**: transcribes `plans/025-statusline-spawn-hygiene.md`,
`plans/026-statusline-cache-correctness.md`, and `plans/027-usage-pipeline-test-gap.md` into
OpenSpec/beads-tracked form. Every step, verification command, and STOP condition in those files
remains authoritative; `tasks.md` here summarizes them at checkbox granularity.

## Testing

- **Unit** (`apps/nexus-statusline/src/index.test.ts`, `bun test`): a shell-hostile-path regression
  pin for the `execFileSync` conversion; spawn-argv assertions proving cachePath/url travel as
  positional args, never in script text; a corrupt-but-fresh-cache regression pin proving refresh
  fires; pid-uniqueness assertions on the two refresh tmp paths; GC prefix coverage across all
  three per-session families; `polledUsageFromCache` boundary tests (fresh/stale/exact-30-min/
  missing `fetched_at`). Expect the suite to grow from 113 to 116+ (batch 1) to 125+ (batch 2).
- **New file** `apps/agent/src/services/statusline-usage-file.test.ts`: 11+ cases covering every
  skip branch, the happy-path `CachedUsage` shape contract, zero/null-limit math, atomic
  tmp+rename with pid suffix and mode 0o600, and fail-soft behavior on db-reject / write-throw —
  all via restorable `spyOn`, never `mock.module` (process-global leak risk, nx-jlx1c).
- **Runtime evidence required, not just unit tests**: task 3.1's md5-diff proof that the new spied
  test suite never touches the operator's real `~/.claude/scripts/state/usage-cache.json`.
- **Wiring proof**: `pnpm --filter @nexus/statusline test` must transition from printing
  `no tests yet` to running the full suite with `0 fail`.
