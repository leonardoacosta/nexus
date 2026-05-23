# complete-next-dashboard-test-coverage

## Why

The `test-infrastructure` capability spec carries two acceptance scenarios that are still
red:

- **AC-13** — `ProjectsTable` Active / Total column assertions for the "2 active / 4 total"
  case.
- **AC-15** — `ProjectsTable` empty-state assertion of the literal text
  `"No projects in registry"`, plus the "0 active / 4 total" zero-session case.

Repo-wide search shows **176 test files** but `apps/nextjs/` currently has **zero** test
files (the `src/` tree was wiped during a prior refactor — only `dist/` and `node_modules/`
remain on disk). The previous fix (`2026-04-07-fix-bun-test-runner`) patched assertions
inside `apps/nextjs/src/__tests__/...` files that no longer exist, so the spec scenarios
report as unmet end-to-end. Without restoring this coverage, the test-infrastructure gate
cannot close: any future regression to the projects table or its empty-state copy will go
unnoticed.

This proposal restores ProjectsTable test coverage as **bun-driven E2E tests under
`tests/e2e/`** (matching the existing pattern in `tests/e2e/dashboard-offline.test.ts`).
That choice keeps the runner singular (`bun:test`) and lets the assertions exercise the
real `ProjectsTable` render path the same way `dashboard-offline.test.ts` exercises
`SessionListPoller`. Playwright is rejected for the same reason called out in
`tests/e2e/README.md`: the regressions being guarded are render-output assertions against
deterministic component output, not headed-browser interactions.

## What Changes

- Add `tests/e2e/projects-table-render.test.ts` covering the AC-13 "2 active / 4 total"
  column-cell assertion on a project row.
- Add `tests/e2e/projects-table-empty-state.test.ts` asserting that the
  `"No projects in registry"` empty-state copy renders when `initialProjects` is empty.
- Add `tests/e2e/projects-table-zero-active.test.ts` covering the AC-15 "0 active /
  4 total" zero-session column-cell assertion.
- Add `tests/e2e/projects-table-row-link.test.ts` sanity-checking that each
  ProjectsTable row exposes a clickable link / href targeting `/projects/<name>`
  (table-interaction smoke).
- Wire the four new tests into `tests/e2e/package.json` (`scripts.test`) so
  `pnpm -F @nexus/e2e test` and the root-level `turbo test` pick them up; confirm
  `turbo.json`'s existing `test` task already invokes the e2e workspace (no edit needed
  unless wiring is missing).

## Context

- depends on: (none)
- touches: `apps/nextjs/tests/...`, `apps/nextjs/package.json`, `turbo.json` (if test task needs wiring)

The ProjectsTable component itself is referenced by archived proposals (e.g.
`2026-04-06-project-tags-and-settings`) at `apps/nextjs/src/components/ProjectsTable.tsx`,
but the on-disk `apps/nextjs/` tree currently contains only build artifacts. Step 1 of
the UI batch verifies whether the component source needs to be restored or whether it
moved to a sibling package; if missing, the test files are written against the
restored source path and the restoration itself is escalated rather than absorbed.

## Impact

- Test-only delta — **no production code modified**, no DB migrations, no API surface
  changes, no Swift app changes.
- Estimated **4-6 files touched** total: four new `.test.ts` files under `tests/e2e/`,
  one `tests/e2e/package.json` script wiring update, optionally one `turbo.json` test
  task tweak.
- Closes the `test-infrastructure` gate end-to-end by retiring the last red scenarios
  (AC-13 × 2, AC-15 × 2).
- No user-facing impact; no rollout coordination needed.
