# audit-suppressions Specification

## Purpose
TBD - created by archiving change finalize-audit-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Suppression config file

audit-scan SHALL read a `.audit-suppressions.json` file from the repository root at scan start. The file SHALL declare per-check-id allowed path patterns with a mandatory human-readable `reason` field.

#### Scenario: Config present with valid entries

- **GIVEN** `.audit-suppressions.json` exists at repo root with an entry for `D4` matching `apps/agent/src/terminal/pty-source.ts`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL NOT emit any D4 finding for that file
- **AND** the JSON output SHALL include a `suppressed` counter showing how many findings were skipped

#### Scenario: Config missing

- **GIVEN** `.audit-suppressions.json` does not exist
- **WHEN** audit-scan runs
- **THEN** the scan SHALL behave as it does today (no suppressions applied)
- **AND** SHALL NOT error

#### Scenario: Suppression entry missing reason field

- **GIVEN** `.audit-suppressions.json` has an entry without a `reason` field
- **WHEN** audit-scan runs
- **THEN** the scan SHALL error with a clear message pointing to the malformed entry
- **AND** SHALL exit with a non-zero code

### Requirement: Test-file auto-skip

audit-scan SHALL automatically skip findings for check IDs listed in `autoSkipTestFiles` when the finding's file path matches a test file pattern (`*.test.ts`, `*.spec.ts`, `**/__tests__/**`, `**/acceptance/**`).

#### Scenario: E7 in a test file is auto-skipped

- **GIVEN** `autoSkipTestFiles` contains `E7`
- **AND** a test file calls `fetch()` without `AbortController`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL NOT emit an E7 finding for that file

#### Scenario: E7 in a production file is still reported

- **GIVEN** `autoSkipTestFiles` contains `E7`
- **AND** `apps/agent/src/routes/credentials.ts` calls `fetch()` without `AbortController`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL emit an E7 finding for that file

### Requirement: Suppression reporting

audit-scan JSON output SHALL include a `suppressions` object counting how many findings per check ID were suppressed by the config and how many by test-file auto-skip.

#### Scenario: Report shows suppression breakdown

- **GIVEN** a scan that suppressed 65 E7 findings via `autoSkipTestFiles` and 4 D4 findings via config
- **WHEN** audit-scan outputs JSON with `--json`
- **THEN** the output SHALL contain `suppressions.byCheck.E7.autoSkipped === 65`
- **AND** `suppressions.byCheck.D4.configSuppressed === 4`

