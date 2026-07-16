<!-- beads:epic:nx-4n8co -->
<!-- beads:feature:nx-snqgv -->

# Tasks: strip-statusline-to-minimal-segments

> Literal `## API/UI/E2E Batch` headers per `/feature`'s wave-plan-build contract — no DB batch
> (no schema/persistence change; nx-agent's own usage-cache writer is explicitly out of scope).
> Sequence tasks so grep-before-delete checks happen before the deletions they gate.

## API Batch

- [x] [1.1] `apps/nexus-statusline/src/agent-lines.ts`: before deleting anything, grep this repo [beads:nx-ft8vn]
  for every caller of `fetchStatusline`, `getRoadmapPulse`, `getSpecsLine`, `getDriftLine`,
  `formatDriftLine` to confirm none has a caller outside this package that would break. Then
  remove `getRoadmapPulse`, `getSpecsLine`, `getDriftLine`, `formatDriftLine` entirely. Remove
  `fetchStatusline` ONLY if the grep confirms no remaining caller (the session-dot and `⚡ spec`
  inline marker were its only known consumers, both being removed in task 1.3/2.1) — if some
  other caller exists, keep the function and cite the caller in the commit instead of deleting.
  Keep `getRoadmapLine` unchanged. [owner:general-purpose] [type:api]
- [x] [1.2] `apps/nexus-statusline/src/usage.ts`: remove `resolveUsage`, `buildStdinUsage`, [beads:nx-7pafg]
  `polledUsageFromCache`, and `FETCH_TIMEOUT_MS` if nothing else references the latter after the
  other three are gone (grep first). Keep `getAccountDomain` unchanged (feeds the kept `@domain`
  segment). [owner:general-purpose] [type:api]
- [x] [1.3] `apps/nexus-statusline/src/speed.ts`: grep for any caller of `getSpeed` outside this [beads:nx-8pop2]
  file; if none exists beyond `render.ts`'s now-removed speed segment, delete the file entirely.
  [owner:general-purpose] [type:api]
- [x] [1.4] `apps/nexus-statusline/src/context-guard.ts`: NO deletion — `resolveContext` still [beads:nx-5am52]
  feeds the separate "nexus-statusline SHALL push its resolved context-window reading to
  nx-agent" requirement (unchanged, out of this proposal's scope). Leave this file as-is; only
  its RENDER-FACING call site in `render.ts` (task 2.1) is removed.
  [owner:general-purpose] [type:api]
- [x] [1.5] `apps/nexus-statusline/src/types.ts`: trim `CcInput`/`RenderDeps` fields that ONLY [beads:nx-vea4r]
  fed now-removed segments (`cost.total_cost_usd`, `cost.total_lines_added`/`removed`,
  `output_style`, `context_window`, `exceeds_200k_tokens`) from this package's OWN local type
  usage. Do NOT touch `packages/statusline-contract`'s shared `UsagePeriod`/`UsageResponse`/
  `CachedUsage` re-exports — those remain a single shared source of truth per the MODIFIED
  requirement, even though this package no longer reads them for rendering.
  [owner:general-purpose] [type:api]

## UI Batch

- [x] [2.1] `apps/nexus-statusline/src/render.ts`: remove the session-dot, `$cost`, `+N/-M` [beads:nx-m51su]
  lines, `M:<model+effort>` token, output-style tag, git-branch/dirty/ahead segment, `⚡ spec`
  inline marker, `200K+` marker, `CTX` gauge, `≈Nt/s` speed, `5H`/`7D` gauges, and the pulse/
  specs/drift trailing-row composition from `renderStatusline`. Keep: `@domain`, project code,
  session clock, worktree badge (re-derive its trigger directly from
  `workspace.git_worktree` if it was previously coupled to the now-removed git-branch fetch —
  check before assuming decoupling is free), and the roadmap trailing row. Update
  `modelEffortToken`'s exported signature/removal accordingly (it's being deleted, not just its
  call site). [owner:general-purpose] [type:ui]
- [x] [2.2] `apps/nexus-statusline/src/index.ts`: remove the parallel fetch calls that only fed [beads:nx-2o2uy]
  now-removed segments — the live `git` subprocess call (`getGitStatus`) if task 2.1 confirms no
  kept segment needs it, and the `fetchStatusline`/speed/usage calls per tasks 1.1-1.3's
  grep-confirmed deletions. Leave the roadmap-line fetch, account-domain resolution, and
  project-dir resolution untouched. [owner:general-purpose] [type:ui]

## E2E Batch

- [x] [3.1] Update `apps/nexus-statusline`'s existing test suite: remove/rewrite fixtures and [beads:nx-3dm82]
  assertions for every removed segment (search for `$`, `CTX`, `5H`, `7D`, `M:`, `200K`,
  `output_style`, drift/pulse/specs-line assertions). Add assertions that a real rendered line
  contains NONE of the removed segments' distinguishing substrings while still containing the
  kept ones (`@`, the project code, the session-clock glyph, the worktree badge marker, the
  roadmap line's format). [owner:general-purpose] [type:api]
- [x] [3.2] Run the package's real test suite (per the unchanged "test script MUST run its real [beads:nx-5l6ts]
  suite" requirement) and confirm it passes with the updated fixtures. Render a real sample
  payload through the trimmed `renderStatusline` directly (not just unit assertions) and paste
  the actual output, confirming visually it matches the kept-segment list with no removed
  segment present. [owner:general-purpose] [type:api]
