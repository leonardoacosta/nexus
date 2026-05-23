<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-rg2p4 -->

# Tasks

## DB Batch

(no DB work)

## API Batch

(no API work)

## UI Batch

- [ ] [1.1] Verify the `ProjectsTable` component source location. Search `apps/nextjs/`
  and sibling packages for `ProjectsTable.tsx`. If the file is absent on disk (the
  current `apps/nextjs/` tree only contains `dist/` and `node_modules/`), STOP and
  escalate before writing tests — the test files need a real import target.
  [owner:ui-engineer]
- [ ] [1.2] Author `tests/e2e/projects-table-render.test.ts` covering the AC-13
  "2 active / 4 total" scenario. Render `ProjectsTable` via `renderToString` (matching
  `tests/e2e/dashboard-offline.test.ts`); assert the row for project `"co"` has an
  `Active` cell with text `"2"` and a `Total` cell with text `"4"`; assertions MUST
  target individual cells, not combined strings such as `"2 active"`.
  [owner:ui-engineer]
- [ ] [1.3] Author `tests/e2e/projects-table-zero-active.test.ts` covering the AC-15
  zero-active scenario. Same render harness; assert the `Active` cell text equals
  `"0"` and the `Total` cell text equals `"4"` for a project with
  `activeSessions = 0, totalSessions = 4`. [owner:ui-engineer]
- [ ] [1.4] Author `tests/e2e/projects-table-empty-state.test.ts` covering the AC-15
  empty-state scenario. Render with `initialProjects = []`; assert the rendered HTML
  contains the literal substring `"No projects in registry"`; explicitly assert that
  the legacy `"NEXUS_PROJECTS_DIR"` text is NOT present.
  [owner:ui-engineer]
- [ ] [1.5] Author `tests/e2e/projects-table-row-link.test.ts` covering the row-link
  sanity scenario. Render with at least one project named `"co"`; assert the rendered
  HTML for that row contains an `<a>` element whose `href` targets `/projects/co`.
  [owner:ui-engineer]
- [ ] [1.6] Apply `bun:test` skip-preflight (no `POSTGRES_URL` dependency required
  for these render-only tests; document the absence of preflight conditions in each
  test file's header comment, mirroring the docblock format used by
  `tests/e2e/dashboard-offline.test.ts`). [owner:ui-engineer]

## E2E Batch

- [ ] [2.1] Wire the four new test files into `tests/e2e/package.json` `scripts.test`
  (add `test:projects-table-render`, `test:projects-table-zero-active`,
  `test:projects-table-empty-state`, `test:projects-table-row-link` and append them
  to the chained `test` script). [owner:e2e-engineer]
- [ ] [2.2] Confirm `turbo.json`'s root `test` task picks up the
  `@nexus/e2e` workspace; if the wiring is missing, add a `tasks.test` entry for the
  workspace so `turbo test` discovers the new tests. [owner:e2e-engineer]
- [ ] [2.3] Run `pnpm -F @nexus/e2e test` locally and confirm the four new tests
  pass (or skip with a documented reason and no failures). Capture the stdout
  snippet as runtime evidence on the parent feature. [owner:e2e-engineer]
- [ ] [2.4] Push and verify CI reports the test-infrastructure gate green —
  specifically, the AC-13 × 2 and AC-15 × 2 scenarios are no longer reported as
  unmet. [owner:e2e-engineer]
