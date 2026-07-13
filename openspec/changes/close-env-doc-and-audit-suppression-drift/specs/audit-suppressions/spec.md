## ADDED Requirements

### Requirement: Test-skip-reason console output suppression

The `.audit-suppressions.json` config SHALL include a narrow, paths-scoped A2 (console.log)
suppression entry, separate from the existing CLI-scripts stanza, covering `console.log` calls
that exist specifically to print a test-skip-reason diagnostic (why a Postgres- or tmux-gated
test block is being skipped in the current environment) and are guarded by an
`// eslint-disable-next-line no-console` comment. `A2` SHALL NOT be added to
`autoSkipTestFiles` — a global test-file auto-skip would also hide a genuine leaked
`console.log` accidentally committed in an unrelated test file.

#### Scenario: Guarded test-skip diagnostic is not reported

- **GIVEN** `apps/agent/src/services/process-watcher.test.ts` contains a
  `// eslint-disable-next-line no-console` guarded `console.log(...)` printing why a
  Postgres-gated test is skipping
- **WHEN** `audit-scan` runs
- **THEN** no A2 finding SHALL be emitted for that file

#### Scenario: An unguarded, non-diagnostic console.log elsewhere in a test file is still reported

- **GIVEN** a test file outside the 3 paths-scoped entries contains an accidental leaked
  `console.log("debug:", foo)` with no `eslint-disable-next-line no-console` guard
- **WHEN** `audit-scan` runs
- **THEN** an A2 finding SHALL still be emitted for that file
- **AND** `A2` SHALL NOT appear in `autoSkipTestFiles`
