## 1. Fix AC-13 session-count assertion

- [ ] 1.1 In `apps/nextjs/src/__tests__/acceptance/ac-13-projects-page.test.tsx` (line 85),
  replace `screen.getAllByText("2 active")` with a query that locates the row for project "co"
  then checks the "Active" column cell contains the number `2` and the "Total" cell contains `4`.
  Use `within()` from `@testing-library/react` if needed, or `getByRole("cell", { name: "2" })`.

- [ ] 1.2 Repeat for the "shows empty state when no projects" test in the same file if it also
  uses a now-stale text assertion.

## 2. Fix AC-15 empty-state assertion

- [ ] 2.1 In `apps/nextjs/src/components/__tests__/ac-15-projects-discovered.test.tsx` (line 72),
  change `expect(screen.getByText(/NEXUS_PROJECTS_DIR/)).toBeInTheDocument()` to
  `expect(screen.getByText(/No projects in registry/)).toBeInTheDocument()`.

## 3. Fix AC-15 session-count assertion

- [ ] 3.1 In the same file (line 79), replace `screen.getAllByText("0 active")` with a query
  matching the numeric Active-column cell (`"0"`) scoped to the project row, or use
  `getAllByRole("cell", { name: "0" })` and verify at least one is present.

## 4. Verify

- [ ] 4.1 Run `cd apps/nextjs && bun run test` (which invokes `vitest run`) and confirm:
  - 0 test files failing
  - All 204+ tests pass (currently 200 pass / 4 fail)
- [ ] 4.2 Confirm no regressions in unrelated test files.
