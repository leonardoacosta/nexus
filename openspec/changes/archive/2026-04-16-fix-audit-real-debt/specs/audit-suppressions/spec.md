# audit-suppressions Specification

## ADDED Requirements

### Requirement: A4 suppression parity with F2

The `.audit-suppressions.json` config SHALL include an A4 (console.error anywhere) entry for the same CLI-script paths covered by the existing F2 (console.error in catch) entry. A4 is a superset of F2; if a path is suppressed for F2, it SHOULD be suppressed for A4.

#### Scenario: Backfill script A4 is not reported

- **GIVEN** `apps/agent/src/scripts/backfill-mcp-providers.ts` contains `console.error(...)` anywhere (catch or not)
- **WHEN** audit-scan runs
- **THEN** no A4 finding SHALL be emitted for that file
- **AND** no F2 finding SHALL be emitted either (already suppressed pre-spec)

#### Scenario: Migration runner paths are covered

- **GIVEN** `packages/db/src/migrations/backfill-credential-fingerprints.ts` contains `console.warn(...)` and `console.error(...)`
- **WHEN** audit-scan runs
- **THEN** no A3, A4, or F2 finding SHALL be emitted for that file
- **AND** the relevant suppression entries SHALL name the `packages/db/src/migrations/**` glob

### Requirement: Test-file auto-skip extended for A3, A4, F2, B4

The `autoSkipTestFiles` array in `.audit-suppressions.json` SHALL include `A3` (console.warn), `A4` (console.error anywhere), `F2` (console.error in catch), and `B4` (file >500 lines) — tests legitimately use console output for diagnostics and can legitimately grow large for comprehensive coverage.

#### Scenario: Integration test console.error is skipped

- **GIVEN** `packages/core/src/audit-suppressions.integration.test.ts` contains `console.error(...)` in test setup or verification
- **WHEN** audit-scan runs
- **THEN** no A4 finding SHALL be emitted for that file

#### Scenario: Large test file is not flagged as architectural debt

- **GIVEN** `apps/agent/src/credentials/credential-pool.test.ts` is 892 lines
- **WHEN** audit-scan runs
- **THEN** no B4 finding SHALL be emitted for that file

### Requirement: Deferred-debt suppression entries reference follow-up beads

When `.audit-suppressions.json` includes an entry that suppresses a category representing real debt that's been deferred (A5 TODO, A12 commented code, B4 large files in production), the entry's `reason` field SHALL name the specific beads issue tracking the follow-up. This keeps the debt discoverable via `bd search` even when audit-scan is silent.

#### Scenario: A5 TODO suppression references tracking bead

- **GIVEN** an A5 TODO finding in `packages/core/src/retry.ts`
- **WHEN** the corresponding suppression entry is added
- **THEN** the entry's `reason` field SHALL match the pattern "Deferred to bead nx-XXXX — [one-line reason]"
- **AND** the referenced bead SHALL exist and be open at the time of this spec's archive
