# audit-debt-baselines Specification

## ADDED Requirements

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
