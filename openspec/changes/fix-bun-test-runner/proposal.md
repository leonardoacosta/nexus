# Change: Fix Failing Next.js Vitest Tests After Component Refactor

## Why

Four tests in the Next.js app fail because their assertions were written against the old
`ProjectCard`-based layout and were never updated when `ProjectsTable` replaced it. The table
renders session counts and labels in separate `<td>` columns (numeric count in "Active", textual
label in the column header) rather than composing them as a single `"2 active"` string inside one
element. Additionally, the AC-15 empty-state test asserts `NEXUS_PROJECTS_DIR` — text that was
removed in commit 9f9d030.

The change ID `fix-bun-test-runner` is retained from the audit brief even though the runner is
already Vitest (`"test": "vitest run"`). No runner migration is needed.

## What Changes

- **AC-13 assertion fix** (`apps/nextjs/src/__tests__/acceptance/ac-13-projects-page.test.tsx:85`):
  Replace `screen.getAllByText("2 active")` with queries that match the split-column table layout —
  locate the row by project name, then assert the "Active" cell contains `2` and "Total" cell
  contains `4`.
- **AC-15 empty-state fix** (`apps/nextjs/src/components/__tests__/ac-15-projects-discovered.test.tsx:72`):
  Update assertion from `NEXUS_PROJECTS_DIR` to the current empty-state text
  `"No projects in registry"`.
- **AC-15 session count fix** (`apps/nextjs/src/components/__tests__/ac-15-projects-discovered.test.tsx:79`):
  Replace `screen.getAllByText("0 active")` with a query that matches the table's split count/label
  layout (numeric `0` in the Active column).

## Impact

- Affected specs: `test-infrastructure` (ADDED — new requirement covering Next.js frontend test
  alignment)
- Affected code:
  - `apps/nextjs/src/__tests__/acceptance/ac-13-projects-page.test.tsx`
  - `apps/nextjs/src/components/__tests__/ac-15-projects-discovered.test.tsx`
- No production code changes; all edits are in test files only.
- Does NOT overlap with `fix-integration-test-gaps` (which covers backend agent and Rust stream
  tests, not frontend component tests).
- CI: no new environment variables required; `vitest run` already passes the 200 tests not
  affected by this change.
