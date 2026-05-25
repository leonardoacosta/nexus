# credential-pool

## ADDED Requirements

### Requirement: Correct Claude Code Credentials Source Path

The system MUST read Claude Code's active auth file from
`~/.claude/.credentials.json` (leading dot), not the non-existent
`~/.claude/credentials.json`, so the Credentials feature discovers the live
fingerprint instead of finding nothing.

#### Scenario: Dotted credentials file exists

- **WHEN** the agent starts and `~/.claude/.credentials.json` exists with a
  valid `claudeAiOauth` block
- **THEN** `cc-credential-manager` reads it, computes a fingerprint, and
  `GET /credentials` returns a non-empty body with an `activeFingerprint`

#### Scenario: Legacy non-dotted path is not used

- **WHEN** only the legacy `~/.claude/credentials.json` (no dot) is present and
  the dotted file is absent
- **THEN** the manager treats credentials as absent rather than reading the
  legacy path, matching real-host behaviour

### Requirement: Transactional Cooldown Recovery During Lease

The system MUST run `recoverExpiredCooldowns()` inside the same database
transaction as `lease()` so a recovered credential cannot be selected by two
concurrent leases, and per-session rotation history MUST be recorded in a
`credential_swaps` table.

#### Scenario: Concurrent lease after cooldown expiry

- **WHEN** two lease requests arrive concurrently and a credential's cooldown
  has just expired
- **THEN** cooldown recovery and selection occur atomically within one
  transaction and the recovered credential is leased to exactly one caller

#### Scenario: Rotation recorded in credential_swaps

- **WHEN** a lease rotates a session from one credential fingerprint to another
- **THEN** a row is inserted into `credential_swaps` capturing the session, the
  previous fingerprint, the new fingerprint, and a timestamp
