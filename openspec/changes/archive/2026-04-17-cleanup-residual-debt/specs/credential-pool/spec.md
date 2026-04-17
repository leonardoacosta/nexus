# credential-pool Specification

## ADDED Requirements

### Requirement: Cache files written with 0o600 mode
All file writes under `apps/nexus-status/src/` that produce credential-adjacent cache files (e.g., `usage-cache.json`, `profile-cache.json`) SHALL pass `{mode: 0o600}` to the `writeFileSync` call (or equivalent async writer). This satisfies the existing `credential-pool` spec's requirement for restrictive permissions on cache files (see `openspec/specs/credential-pool/spec.md` lines 13/54/80) even though the cached data is low-sensitivity (utilization percentages, email domains — no tokens).

#### Scenario: usage-cache.json written with 0600
- **GIVEN** the nexus-status CLI writes to `usage-cache.json`
- **WHEN** the write occurs
- **THEN** the underlying `writeFileSync` call SHALL include `{mode: 0o600}` in its options
- **AND** the file on disk SHALL have mode `0600` (verified via `fs.statSync`)

#### Scenario: profile-cache.json written with 0600
- **GIVEN** the nexus-status CLI writes to `profile-cache.json`
- **WHEN** the write occurs
- **THEN** the file SHALL have mode `0600`

#### Scenario: Existing cache files are replaced with correct mode
- **GIVEN** a previously-written cache file with mode `0644` (pre-fix)
- **WHEN** the nexus-status CLI runs and writes a new version
- **THEN** the new file SHALL have mode `0600` (Node's `writeFileSync` with `{mode}` replaces, not merges, existing permissions)
