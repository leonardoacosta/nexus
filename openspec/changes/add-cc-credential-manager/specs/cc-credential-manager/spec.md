## ADDED Requirements

### Requirement: cc_profiles table SHALL track every observed Claude profile

A new table `cc_profiles` SHALL be created with columns: `id (PK, text)`, `type ('pro' | 'max' | 'api_key')`, `oauth_refresh_token (encrypted text)`, `expiry_ts (timestamp)`, `last_used_ts (timestamp)`, `current_cost_usd (decimal)`, `rate_limit_status (text)`. One row per profile.

#### Scenario: schema migration creates table
- **GIVEN** a database without cc_profiles
- **WHEN** the Drizzle migration runs
- **THEN** cc_profiles exists with all required columns and a unique index on `id`

### Requirement: agent SHALL proactively refresh tokens before expiry

When a profile's `expiry_ts` is within 5 minutes, the cc-credential-manager SHALL call CC's OAuth refresh endpoint, update the token in `~/.claude/credentials.json` (with backup-before-write), and emit a `CCProfileRefreshed` event.

#### Scenario: token refreshed 5 min before expiry
- **GIVEN** profile A has `expiry_ts = NOW + 4 min`
- **WHEN** the manager's refresh loop runs
- **THEN** the OAuth endpoint is called, credentials.json is updated with the new token, and a CCProfileRefreshed event is emitted

### Requirement: agent SHALL swap profiles on rate-limit detection

When the manager detects a 429 rate-limit response for the current profile, it SHALL select the next eligible profile (least-recently-used, not currently rate-limited), write it to `credentials.json`, and emit a `CCProfileSwapped` event. Per Leo's observation, CC re-reads credentials.json automatically — no session restart needed.

#### Scenario: rate-limit triggers swap
- **GIVEN** profile A is current and CC reports 429
- **WHEN** the manager detects the 429
- **THEN** profile B is written to credentials.json within 100ms; the next CC API call (from any session) uses profile B

### Requirement: schema drift in credentials.json SHALL be detected and surfaced

The manager SHALL fingerprint the credentials.json schema on every read. On format diff (CC adds a new field or restructures), it SHALL emit a `CCAuthSchemaDrift` event and fall back to passive-observe mode (no writes) until the new format is supported.

#### Scenario: drift falls back to passive mode
- **GIVEN** CC ships a credentials.json schema change
- **WHEN** the manager next reads credentials.json
- **THEN** one `CCAuthSchemaDrift` event is emitted AND subsequent refresh/swap attempts are skipped (logged, not executed) until the new schema is supported

## RENAMED Requirements

- FROM: `### Requirement: credential_events table`
- TO: `### Requirement: cc_profile_events table`

**Rationale**: the existing table was misnamed (intended for CC profile rotation, used only for ElevenLabs). Renaming makes intent explicit. ElevenLabs handling is fully removed in P4.5.

#### Scenario: rename is non-destructive
- **GIVEN** existing credential_events rows
- **WHEN** the rename migration runs
- **THEN** all rows are preserved under the new table name with identical content
