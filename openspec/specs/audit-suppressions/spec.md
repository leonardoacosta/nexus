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

