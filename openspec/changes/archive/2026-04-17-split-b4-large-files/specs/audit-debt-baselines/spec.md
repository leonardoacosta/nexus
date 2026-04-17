# audit-debt-baselines Specification

## ADDED Requirements

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
