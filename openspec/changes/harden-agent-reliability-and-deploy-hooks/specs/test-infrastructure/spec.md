## ADDED Requirements

### Requirement: Test files SHALL isolate database/schema state per test case

A test file sharing one database/schema handle across multiple test cases via `beforeAll` MUST
perform per-test cleanup (or equivalent per-test isolation) so an earlier test's inserted rows
cannot change a later test's pass/fail outcome depending on declaration/run order.

#### Scenario: reaper-persistence tests pass regardless of declaration order

- **GIVEN** `services/reaper-persistence.test.ts`'s "persists a clear-run success with no bloat
  rows" case runs before "returns stale=true when the latest success is older than 8 days"
- **WHEN** the full test file runs in its declared order
- **THEN** the "stale" test's assertion is unaffected by rows the earlier test inserted
- **AND** running the two tests in reverse declared order produces the same pass/fail outcome

### Requirement: PG-gated tests SHALL NOT cross-contaminate under a full-suite heavy-test run

Tests gated by `NEXUS_PG_TESTS`/`NEXUS_HEAVY_TESTS` MUST produce the same pass/fail outcome
whether run standalone or as part of a full `bun test apps/agent` run — `mock.module` mocks
installed by one test file MUST NOT leak into another file's test execution.

#### Scenario: process-watcher tests pass identically standalone and in the full suite

- **GIVEN** `NEXUS_PG_TESTS=1 NEXUS_HEAVY_TESTS=1 bun test apps/agent/src/services/process-watcher.test.ts` passes standalone
- **WHEN** the same environment runs the full `bun test apps/agent` suite
- **THEN** `process-watcher.test.ts`'s tests produce the identical pass/fail outcome as the
  standalone run — no `mock.module` state from another file changes the result
