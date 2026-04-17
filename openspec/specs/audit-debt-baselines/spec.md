# audit-debt-baselines Specification

## Purpose
TBD - created by archiving change fix-audit-real-debt. Update Purpose after archive.
## Requirements
### Requirement: Post-cleanup rule-level baselines

After this change lands, audit-scan against the nx repo SHALL emit zero findings for each of the following rule IDs: A3, A4, A9, C2, C5, C15, F2. Any deviation SHALL either fail the integration test OR be accompanied by a spec update that revises this baseline explicitly.

#### Scenario: A4 count is zero

- **WHEN** audit-scan runs against `/home/nyaptor/dev/nx`
- **THEN** `findings.filter(f => f.id === "A4").length === 0`

#### Scenario: A9 count is zero

- **WHEN** audit-scan runs against `/home/nyaptor/dev/nx`
- **THEN** `findings.filter(f => f.id === "A9").length === 0`

#### Scenario: C5 count is zero

- **WHEN** audit-scan runs against `/home/nyaptor/dev/nx`
- **THEN** `findings.filter(f => f.id === "C5").length === 0`

#### Scenario: F2 count is zero

- **WHEN** audit-scan runs against `/home/nyaptor/dev/nx`
- **THEN** `findings.filter(f => f.id === "F2").length === 0`

### Requirement: E7 self-reference tolerance

`packages/core/src/fetch.ts` IS the `fetchWithTimeout` wrapper. If audit-scan continues to flag it for E7 (lacking its own AbortController), the integration test SHALL tolerate exactly one E7 finding pointing at that file OR the file SHALL be suppressed in `.audit-suppressions.json` with a `reason` field naming the self-reference pattern.

#### Scenario: Wrapper self-reference does not break the baseline

- **GIVEN** `packages/core/src/fetch.ts:15` is still flagged for E7
- **WHEN** the integration test runs
- **THEN** the E7 assertion SHALL permit either 0 findings (if suppressed) or exactly 1 finding (if not, and self-ref is the only one)
- **AND** the test comment SHALL document which mode is active

### Requirement: D5 residual flag

If the `dangerouslySetInnerHTML` site at `apps/nextjs/src/app/credentials/page.tsx:80` is retained (content is a constant literal, not user data) and suppressed, the integration test SHALL assert D5 count is 0. If retained without suppression, D5 count SHALL be exactly 1 and the integration test SHALL document why.

#### Scenario: D5 after cleanup is zero or exactly one

- **WHEN** the integration test runs
- **THEN** `findings.filter(f => f.id === "D5").length` SHALL be 0 or 1
- **AND** if 1, the test comment SHALL document the justification and link the risk review

### Requirement: Composite score floor

The integration test SHALL assert composite score is at least 88 after this change. Higher is tolerated but the assertion SHALL NOT be strict equality — rule refinements in future may alter the number.

#### Scenario: Score passes the 88 floor

- **WHEN** the integration test runs
- **THEN** `scan.score >= 88` SHALL hold
- **AND** the test comment SHALL document the previous baseline (83) and the delta attribution

### Requirement: B4 count is zero after production-file splits
After this change lands, audit-scan against the nx repo SHALL emit zero B4 (file >500 lines) findings for production files. Test files remain auto-skipped via the existing `autoSkipTestFiles: ["B4", ...]` mechanism.

#### Scenario: B4 finding count is zero on the nx repo
- **WHEN** audit-scan runs against `/home/nyaptor/dev/nx`
- **THEN** `findings.filter(f => f.id === "B4").length === 0`
- **AND** the composite score SHALL hold at ≥ 99

#### Scenario: New >500-line production file is still flagged
- **GIVEN** a new file `apps/agent/src/routes/some-new-big-route.ts` exceeding 500 lines is added to the repo
- **WHEN** audit-scan runs
- **THEN** it SHALL emit a B4 finding for that file (i.e., the rule still works; only the current offenders are resolved)

### Requirement: Barrel re-exports preserve public contract
The original file paths of the 6 split files SHALL remain valid import targets. Any consumer importing from `apps/agent/src/credentials/pool`, `apps/agent/src/server`, `apps/agent/src/routes`, `apps/agent/src/routes/credentials`, `apps/agent/src/services/socket-server`, or `apps/nextjs/src/components/CredentialsTable` SHALL resolve to the expected symbol set without the consumer needing to change its import path.

#### Scenario: Existing imports resolve after split
- **GIVEN** a consumer file contains `import { CredentialPool } from "./credentials/pool"`
- **WHEN** `pool.ts` has been split into `./credentials/pool/` subdir with `pool.ts` becoming a barrel
- **THEN** the consumer's import SHALL still resolve to the `CredentialPool` class
- **AND** `pnpm --filter @nexus/agent typecheck` SHALL pass

#### Scenario: All pre-existing tests pass unchanged
- **GIVEN** the full test suite passed before the split
- **WHEN** the split is applied
- **THEN** the full test suite SHALL still pass with no test-file modifications required
- **AND** `pnpm turbo run test --filter=@nexus/agent --filter=@nexus/nextjs` SHALL succeed

