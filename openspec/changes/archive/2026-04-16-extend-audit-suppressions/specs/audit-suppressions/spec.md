# audit-suppressions Specification

## ADDED Requirements

### Requirement: CLI-script console output suppression

The `.audit-suppressions.json` config SHALL include entries suppressing A2 (console.log) and F2 (console.error) findings for CLI one-shot scripts and migration runners, where console output is the intentional user-facing output channel.

#### Scenario: Backfill script console.log is not reported

- **GIVEN** `apps/agent/src/scripts/backfill-mcp-providers.ts` contains `console.log(...)` calls
- **WHEN** audit-scan runs
- **THEN** no A2 finding SHALL be emitted for that file

#### Scenario: Migration runner console.error is not reported

- **GIVEN** `packages/db/src/migrate.ts` contains `console.error(...)` calls
- **WHEN** audit-scan runs
- **THEN** no F2 finding SHALL be emitted for that file

#### Scenario: Production app code console.error is still reported

- **GIVEN** `apps/nextjs/src/components/CommandPalette.tsx` contains `console.error(...)` at line 139
- **WHEN** audit-scan runs
- **THEN** an F2 finding SHALL still be emitted for that file
- **AND** the suppression config SHALL NOT match UI component paths

### Requirement: Boot-phase sync I/O suppression

The `.audit-suppressions.json` config SHALL include entries suppressing E5 (sync I/O) findings for boot-phase config loaders and CLI utilities. The suppression SHALL be scoped to specific files, not the entire repo, so sync I/O introduced into request-path code remains flagged.

#### Scenario: Config loader sync read is not reported

- **GIVEN** `packages/core/src/config.ts` uses `fs.readFileSync` at module load
- **WHEN** audit-scan runs
- **THEN** no E5 finding SHALL be emitted for that file

#### Scenario: nexus-status sync I/O is not reported

- **GIVEN** `apps/nexus-status/src/index.ts` uses sync I/O across multiple lines
- **WHEN** audit-scan runs
- **THEN** no E5 finding SHALL be emitted for any line in that file

#### Scenario: Sync I/O in a request path is still reported

- **GIVEN** a hypothetical new `apps/agent/src/routes/sessions.ts` introduces `fs.readFileSync` on a request handler
- **WHEN** audit-scan runs
- **THEN** an E5 finding SHALL be emitted (the suppression globs do not match request-path files)

### Requirement: safeSpawn wrapper and trusted constant-arg exec suppression

The `.audit-suppressions.json` config SHALL include D4 (exec/spawn risk) entries for the `safeSpawn` wrapper itself, for the `nexus-status` CLI binary's constant-arg git probes, and for the `agent-registry` tailscale IP lookup. These are self-reference / constant-arg cases with no user-controlled input.

#### Scenario: safeSpawn self-reference is not reported

- **GIVEN** `packages/core/src/safe-spawn.ts` contains a `spawn` call at line 196 (the wrapper's internal spawn)
- **WHEN** audit-scan runs
- **THEN** no D4 finding SHALL be emitted for that line

#### Scenario: Constant-arg git probe is not reported

- **GIVEN** `apps/nexus-status/src/index.ts` contains `execSync('git rev-parse ...')` style probes at lines 147/154/163 with no template interpolation of user-controlled data
- **WHEN** audit-scan runs
- **THEN** no D4 finding SHALL be emitted for those lines

### Requirement: Suppression reason field required per entry

Every new suppression entry added in this change SHALL include a non-empty `reason` field that explains the intentional-correctness rationale and references either the relevant design doc, the prior spec, or the invariant being preserved. This preserves the existing CI lint gate (`scripts/validate-audit-suppressions.sh`) and prevents the config from becoming a dumping ground.

#### Scenario: Each new entry passes the existing CI lint

- **WHEN** `scripts/validate-audit-suppressions.sh` runs against the updated config
- **THEN** the script SHALL exit 0
- **AND** every entry SHALL have a `reason` with length > 0 after trimming

### Requirement: Post-suppression audit baseline

After this change lands, the audit-scan integration test suite SHALL assert the new per-rule baselines: A2 count is 0, E5 count is 0, D4 count is 0, F2 count is exactly 3 (documented UI debt), and the composite score is at least 83.

#### Scenario: Integration test passes after suppressions are in place

- **GIVEN** `packages/core/src/audit-suppressions.integration.test.ts` is updated with the new baselines
- **WHEN** the test suite runs against the nx repo
- **THEN** all baseline assertions SHALL pass
- **AND** a comment SHALL document the 3 unsuppressed F2 findings as real UI debt tracked in the follow-up bead
