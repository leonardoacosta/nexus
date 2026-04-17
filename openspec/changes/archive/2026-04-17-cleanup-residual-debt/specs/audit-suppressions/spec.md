# audit-suppressions Specification

## ADDED Requirements

### Requirement: Suppressions retired when underlying issue is resolved
When a suppression entry was added to cover a specific known issue (a file-path-keyed entry with a `reason` field citing that issue), and the underlying issue is fixed or becomes irrelevant, the suppression entry SHALL be removed from `.audit-suppressions.json` in the same change that lands the fix.

#### Scenario: A12 rule refinement retires A12 suppressions
- **GIVEN** the A12 rule has been refined to require a code-syntax signal
- **AND** the `.audit-suppressions.json` file previously had A12 entries covering `apps/agent/src/services/socket-server.test.ts` and `apps/agent/src/session-manager.ts` (both for false-positive reasons)
- **WHEN** the refinement lands
- **THEN** those two A12 entries SHALL be removed
- **AND** the CI lint (`scripts/validate-audit-suppressions.sh`) SHALL still pass

#### Scenario: A5 TODO resolution retires A5 suppressions
- **GIVEN** the TODO at `apps/agent/src/credentials/token-stream/attribution.ts:42` is replaced with a comment referencing a specific tracking bead
- **AND** the skipped tests in `apps/agent/src/db/db.test.ts:29` are implemented
- **WHEN** both resolutions land
- **THEN** the A5 suppression entries for those two paths SHALL be removed

### Requirement: TODO conversion pattern for deferred future work
When an A5 TODO comment is kept as a deliberate pointer to future work (not resolvable now), it SHALL be replaced with a comment that references a specific tracked bead ID. The A5 suppression for that file SHALL then be removed (the referenced bead is the tracking mechanism, not the suppression).

#### Scenario: Attribution TODO references tracking bead
- **GIVEN** `attribution.ts:42` contains a TODO about future credential_swaps table queries
- **WHEN** the work is deferred (not implemented in this spec)
- **THEN** a new bead (type=task, priority=3, label=audit-debt) SHALL be filed with a clear description of the future work
- **AND** the comment SHALL be updated to reference that bead's ID (e.g., `// Future: see nx-XXXX for credential_swaps table implementation`)
- **AND** the A5 suppression for `attribution.ts` SHALL be removed
