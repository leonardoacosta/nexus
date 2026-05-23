# test-infrastructure Specification Delta

## ADDED Requirements

### Requirement: Next.js Dashboard ProjectsTable Test Coverage

The `tests/e2e/` workspace SHALL contain executable `bun:test` files that render the
real `ProjectsTable` component (via the same server-rendering path used by
`tests/e2e/dashboard-offline.test.ts`) and assert against its actual DOM output for the
two acceptance scenarios still tracked under `test-infrastructure`: AC-13
(populated-table column values) and AC-15 (empty-state copy + zero-active column
values). Each assertion MUST target individual table cells (column-scoped) rather than
combined human-readable strings such as `"2 active"`, mirroring the constraint already
codified by the `Next.js Frontend Test Alignment` requirement. The new files MUST be
wired into `tests/e2e/package.json`'s `scripts.test` so the root `turbo test` task
discovers them.

#### Scenario: AC-13 populated table renders 2 active and 4 total cells

- **GIVEN** `initialProjects` contains a project named `"co"` with
  `activeSessions = 2` and `totalSessions = 4`
- **WHEN** `ProjectsTable` is rendered against that input via `renderToString`
- **THEN** the row whose name cell contains `"co"` has an `Active` column cell whose
  text equals `"2"`
- **AND** the same row has a `Total` column cell whose text equals `"4"`
- **AND** the assertion MUST NOT match the combined string `"2 active"`

#### Scenario: AC-15 zero-active row renders 0 in the Active cell

- **GIVEN** `initialProjects` contains a project with `activeSessions = 0` and
  `totalSessions = 4`
- **WHEN** `ProjectsTable` is rendered against that input
- **THEN** the row's `Active` column cell text equals `"0"`
- **AND** the row's `Total` column cell text equals `"4"`
- **AND** the assertion MUST NOT match the combined string `"0 active"`

#### Scenario: AC-15 empty state surfaces "No projects in registry"

- **GIVEN** `initialProjects` is an empty array
- **WHEN** the projects-page renderer (or `ProjectsTable` empty-state branch) is
  rendered via `renderToString`
- **THEN** the rendered HTML contains the literal substring
  `"No projects in registry"`
- **AND** the assertion MUST NOT match the legacy string `NEXUS_PROJECTS_DIR`

#### Scenario: ProjectsTable rows expose a navigable link to the project detail page

- **GIVEN** `initialProjects` contains at least one project named `"co"`
- **WHEN** `ProjectsTable` is rendered
- **THEN** the rendered HTML for that row contains an `<a>` element (or
  equivalent client-side link) whose `href` attribute targets `/projects/co`
- **AND** the link element is associated with the row for project `"co"` (i.e.
  it is reachable via the row's accessible name / DOM subtree)

#### Scenario: tests are wired into the e2e workspace runner

- **GIVEN** the new test files exist under `tests/e2e/`
- **WHEN** a developer runs `pnpm -F @nexus/e2e test` (or `turbo test` from the
  repo root)
- **THEN** all four new ProjectsTable test files are discovered and executed
- **AND** the runner reports them in the per-test output (pass, fail, or skip
  with documented reason)
