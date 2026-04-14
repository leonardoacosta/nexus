# credential-pool Specification

## Purpose
TBD - created by archiving change add-credential-rotation. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL manage credential files
The agent MUST discover and parse OAuth credential files from
`~/.config/nexus/credentials/`. Every parsed file MUST receive a fingerprint
computed from its `claudeAiOauth.refreshToken` (see the fingerprint
requirement). Files that share a fingerprint MUST be joined into a single
duplicate group, with the newest-mtime file marked `is_primary = true` (tied
mtimes broken by alphabetical filename). The usage-cache file
`~/.config/nexus/state/usage-cache.json` MUST be written with `0o600` file
permissions, consistent with pool credential files. When the file watcher
detects a new file at runtime it MUST compute the fingerprint and route the
row through the same group-assignment logic as startup; when the watcher
detects a removed file that was the current primary of a multi-member group,
it MUST promote the newest remaining sibling (alphabetical tiebreak) before
removing the row.

#### Scenario: Startup with credentials directory
Given the directory `~/.config/nexus/credentials/` contains `acct-personal.json` and `acct-work.json` with distinct refresh tokens
When the agent starts
Then it parses both files, computes a fingerprint for each, and registers two `CredentialAccount` entries with name, path, access_token, and `is_primary = true`

#### Scenario: Startup with duplicate snapshots
Given the directory contains `acct-personal-old.json` and `acct-personal-new.json` whose plaintexts share the same `claudeAiOauth.refreshToken`
When the agent starts
Then both files are persisted as rows in the same duplicate group, the newer-mtime row is marked `is_primary = true`, and the older row is `is_primary = false`

#### Scenario: Startup without credentials directory
Given `~/.config/nexus/credentials/` does not exist
When the agent starts
Then the credential pool operates in passthrough mode with zero accounts and no interception

#### Scenario: Credential file added at runtime — new group
Given the agent is running with one credential in group `FP1`
When a new file `acct-team.json` is created with a refresh token hashing to `FP2`
Then the watcher adds a new row with `fingerprint = FP2`, `is_primary = true`, and a new single-member duplicate group within 2 seconds

#### Scenario: Credential file added at runtime — joins existing group
Given the agent is running with credential "a" in group `FP1` as primary
When a new file `acct-a-snapshot.json` is created whose refresh token also hashes to `FP1` and whose mtime is newer than "a"
Then the watcher adds the new row, marks it `is_primary = true`, and demotes "a" to `is_primary = false` within 2 seconds

#### Scenario: Primary credential file removed at runtime
Given the agent is running with credentials "a" (primary) and "b" (non-primary) in the same group, and "a" is the active symlink target
When `acct-a.json` is deleted from the credentials directory
Then the watcher promotes "b" to `is_primary = true`, swaps the symlink to "b", and removes "a" from the pool

#### Scenario: Usage-cache written with restricted permissions
Given usage data has been polled for all credentials
When the cache file is written atomically
Then the resulting file has mode `0o600` (owner read/write only)

#### Scenario: Malformed account filename (empty name)
Given the credentials directory contains `acct-.json`
When the agent parses the filename via `derive_account_name`
Then it returns a parse error, logs a WARN, and skips the file without inserting an empty-key entry into pool state

### Requirement: The system SHALL poll the usage API with hybrid strategy
The service MUST poll the Anthropic usage API for each credential on a 5-minute interval and MUST
immediately poll on rate limit detection. If a credential's 5-hour utilization reaches or exceeds
the pre-rotation threshold (default 85%, configurable via `NEXUS_PREROTATE_THRESHOLD`), the pool
MUST proactively rotate the affected credential before a hard API limit is encountered.

#### Scenario: Proactive polling
Given two credentials are registered
When the 5-minute poll interval fires
Then the service queries `/api/oauth/usage` for each credential's access token and updates utilization and resets_at

#### Scenario: On-demand polling on rate limit
Given a rate limit event is detected
When the interceptor requests current usage
Then the service immediately polls all credentials (bypassing the interval) and returns fresh data

#### Scenario: Usage cache persistence
Given usage data has been polled for all credentials
When the poll completes
Then results are written to `~/.config/nexus/state/usage-cache.json` atomically with `0o600` permissions

#### Scenario: Startup with cached usage
Given `~/.config/nexus/state/usage-cache.json` exists with data less than 10 minutes old
When the agent starts
Then it loads cached usage data immediately and defers the first API poll to the next interval

#### Scenario: Predictive pre-rotation triggers at threshold
Given credential "personal" is leased and has 5h utilization of 87%
And `NEXUS_PREROTATE_THRESHOLD` is 0.85
When the usage poll completes
Then the pool proactively rotates "personal" to the next available credential before a rate-limit response is received

#### Scenario: Predictive pre-rotation does not trigger below threshold
Given credential "work" has 5h utilization of 80%
And `NEXUS_PREROTATE_THRESHOLD` is 0.85
When the usage poll completes
Then no rotation occurs and "work" remains leased

### Requirement: The system SHALL store credential values encrypted at rest
All credential values MUST be encrypted with AES-256-GCM using a 256-bit key supplied via the
`NEXUS_ENCRYPTION_KEY` environment variable before being written to the `credentials` table.
Plaintext values MUST NOT persist in the database. The agent MUST fail to start if
`NEXUS_ENCRYPTION_KEY` is absent or malformed.

#### Scenario: Credential added — value encrypted in database
Given `NEXUS_ENCRYPTION_KEY` is set to a valid 32-byte key
When `POST /credentials` is called with `{ "id": "c1", "name": "personal", "type": "oauth", "value": "token123" }`
Then the database row has `value_encrypted` set to a base64-encoded AES-256-GCM ciphertext and `value_plaintext` does not exist

#### Scenario: Credential leased — decrypted value returned to caller
Given credential "c1" is stored with an encrypted value
When `POST /credentials/lease` is called
Then the returned credential object contains the decrypted plaintext token

#### Scenario: Agent startup fails without encryption key
Given `NEXUS_ENCRYPTION_KEY` is not set in the environment
When the agent process starts
Then it exits with a non-zero status code and logs "NEXUS_ENCRYPTION_KEY is required"

#### Scenario: Agent startup fails with malformed encryption key
Given `NEXUS_ENCRYPTION_KEY` is set to a 10-character string (too short)
When the agent process starts
Then it exits with a non-zero status code and logs "NEXUS_ENCRYPTION_KEY must decode to exactly 32 bytes"

### Requirement: The system SHALL select credentials using weighted round-robin
The lease selection MUST prefer credentials with lower historical rate-limit
frequency. Available credentials of the requested type MUST be filtered to
`is_primary = true` and ordered by `rate_limit_count ASC` (then `leased_at ASC
NULLS FIRST`) so that credentials that have triggered fewer rate limits are
leased first. Non-primary duplicate rows MUST NOT participate in selection
regardless of their `rate_limit_count`. `reportRateLimit` MUST increment
`rate_limit_count` on the affected credential.

#### Scenario: Prefer credential with fewer rate limits
Given credentials "A" (rate_limit_count=0, is_primary=true) and "B" (rate_limit_count=3, is_primary=true) are both available with type "oauth"
When `POST /credentials/lease` is called with type "oauth"
Then credential "A" is leased

#### Scenario: Non-primary duplicate excluded from selection
Given credentials "A" (rate_limit_count=3, is_primary=true) and "A-old" (rate_limit_count=0, is_primary=false) are both in the same fingerprint group with type "oauth"
When `POST /credentials/lease` is called with type "oauth"
Then credential "A" is leased and "A-old" is never considered

#### Scenario: rate_limit_count incremented on report
Given credential "A" has rate_limit_count=0 and is leased
When `POST /credentials/A/report-rate-limit` is called
Then credential "A" enters cooldown and its rate_limit_count is incremented to 1

### Requirement: The system SHALL provide per-credential health checks
The HTTP server MUST expose `GET /credentials/{id}/health` which calls the upstream Anthropic API
with the stored credential and returns whether the token is valid and not revoked.

#### Scenario: Healthy credential returns true
Given credential "c1" holds a valid, non-revoked token
When `GET /credentials/c1/health` is called
Then the response is `{ "healthy": true, "checked_at": "<ISO8601>" }` with status 200

#### Scenario: Revoked credential returns false
Given credential "c2" holds a revoked or expired token
When `GET /credentials/c2/health` is called
Then the response is `{ "healthy": false, "checked_at": "<ISO8601>" }` with status 200

#### Scenario: Unknown credential returns 404
Given no credential with id "missing" exists
When `GET /credentials/missing/health` is called
Then the response status is 404

### Requirement: The system SHALL enforce HTTPS on the credential ingest endpoint
`POST /credentials` MUST reject requests that arrive over plain HTTP from non-loopback addresses.
Loopback callers (`127.0.0.1`, `::1`) are exempt to support local integration tests.

#### Scenario: Remote HTTP request rejected
Given a request to `POST /credentials` arrives with `http://` scheme from a non-loopback address
When the handler evaluates the request
Then it returns `426 Upgrade Required` with header `Upgrade: TLS/1.2, HTTPS`

#### Scenario: Remote HTTPS request accepted
Given a request to `POST /credentials` arrives with `https://` scheme
When the handler evaluates the request
Then it proceeds to validate and store the credential normally

#### Scenario: Loopback HTTP request accepted
Given a request to `POST /credentials` arrives from `127.0.0.1` over HTTP
When the handler evaluates the request
Then it proceeds normally (test/local exemption)

### Requirement: The system SHALL emit structured lifecycle events for credential operations
The system SHALL emit a structured log event for each credential lifecycle transition (lease, release,
cooldown entry, cooldown exit, stale release, predictive pre-rotation) with an `event` field using
the canonical naming scheme `credential.<action>`. These events form the integration contract for
future OTel/Sentry wiring.

#### Scenario: Lease event emitted
Given credential "c1" is available
When `POST /credentials/lease` successfully leases "c1"
Then a log entry with `event: "credential.leased"` and `id: "c1"` is emitted at INFO level

#### Scenario: Cooldown entry event emitted
Given credential "c1" is leased
When `POST /credentials/c1/report-rate-limit` is called
Then a log entry with `event: "credential.cooldown_entered"` and `id: "c1"` is emitted

#### Scenario: Cleanup timer errors logged not swallowed
Given the cleanup timer fires and `recoverExpiredCooldowns` throws an unexpected error
When the interval callback executes
Then the error is caught and logged at ERROR level; the timer continues to run on the next tick

### Requirement: The system SHALL have complete test coverage for credential operations
All test suites in `apps/agent/src/credentials/credentials.test.ts` MUST be active. No `.skip`
stubs are permitted in the credential test file.

#### Scenario: All credential test suites execute
Given the test suite file contains test blocks
When `bun test` runs the credential test file
Then all test blocks execute (zero skipped suites) and the suite passes

### Requirement: The system SHALL assign a stable fingerprint to every credential
Every row in the `credentials` table SHALL carry a non-null `fingerprint`
column computed as the lowercase-hex SHA-256 of the credential's OAuth
`claudeAiOauth.refreshToken`. The fingerprint MUST be computed from the
decrypted plaintext before insert and MUST NOT be derived from the credential
filename, id, or ciphertext. If the plaintext cannot be parsed or has no
`refreshToken`, the fingerprint MUST be set to the literal string `UNKNOWN-`
concatenated with the credential's row id, and a WARN log entry MUST be
emitted.

#### Scenario: New credential receives a fingerprint
- **GIVEN** the credential pool is empty
- **WHEN** `CredentialPool.add()` is called with a value containing
  `claudeAiOauth.refreshToken = "rt_abc"`
- **THEN** the inserted row has `fingerprint = sha256_hex("rt_abc")` and
  `duplicate_group_id` equal to the same hash

#### Scenario: Malformed credential falls back to a degenerate fingerprint
- **GIVEN** the pool is asked to add a credential whose plaintext is not valid
  OAuth JSON
- **WHEN** `CredentialPool.add()` computes the fingerprint
- **THEN** the row is inserted with `fingerprint = "UNKNOWN-" || id` and
  `is_primary = true`
- **AND** a WARN entry is logged naming the offending credential id

#### Scenario: Identical refresh tokens produce identical fingerprints
- **GIVEN** two credentials whose plaintext contains the same
  `claudeAiOauth.refreshToken`
- **WHEN** both are loaded via `CredentialPool.add()`
- **THEN** both rows have the same `fingerprint` value and the same
  `duplicate_group_id`

### Requirement: The system SHALL group duplicate credentials without silent deduplication
Credentials that share a fingerprint SHALL be linked by a common
`duplicate_group_id` (which equals the shared fingerprint). Within every group
exactly one row SHALL have `is_primary = true`; all other rows in the group
SHALL have `is_primary = false`. Non-primary rows MUST remain persisted,
visible through `GET /credentials`, and untouched by lease selection.

#### Scenario: Second duplicate becomes a non-primary sibling
- **GIVEN** the pool already contains credential "a" with fingerprint `FP` and
  `is_primary = true`
- **WHEN** `CredentialPool.add()` inserts credential "b" with the same
  fingerprint `FP` and an older mtime than "a"
- **THEN** "b" is stored with `is_primary = false` and
  `duplicate_group_id = FP`
- **AND** "a" retains `is_primary = true`

#### Scenario: Newer duplicate demotes the existing primary
- **GIVEN** the pool already contains credential "a" with fingerprint `FP` and
  `is_primary = true`
- **WHEN** `CredentialPool.add()` inserts credential "b" with the same
  fingerprint `FP` and a newer mtime than "a"
- **THEN** "b" becomes `is_primary = true`, "a" becomes `is_primary = false`,
  and both rows share `duplicate_group_id = FP`

#### Scenario: Tied mtime falls back to alphabetical filename
- **GIVEN** two credentials share a fingerprint and have identical mtimes
- **WHEN** the primary is selected during insert or migration backfill
- **THEN** the row whose `name` sorts first lexicographically is marked
  `is_primary = true`

### Requirement: The system SHALL restrict lease selection to primary credentials
`CredentialPool.lease()` SHALL only consider rows where `is_primary = true`
when selecting the next available credential, in addition to the existing
status and type predicates. Non-primary rows MUST NOT be returned by any lease
call regardless of their `rate_limit_count` or `leased_at` values.

#### Scenario: Lease skips a non-primary sibling with lower rate-limit count
- **GIVEN** credentials "a" (`is_primary = true`, `rate_limit_count = 3`) and
  "b" (`is_primary = false`, `rate_limit_count = 0`) share a fingerprint
- **WHEN** `POST /credentials/lease` is called
- **THEN** credential "a" is leased and "b" is never considered

#### Scenario: Lease succeeds for a single-member group
- **GIVEN** the pool contains exactly one credential with `is_primary = true`
- **WHEN** `POST /credentials/lease` is called
- **THEN** that credential is leased as before with no behavior change

### Requirement: The system SHALL expose duplicate grouping in the credentials listing
`GET /credentials` SHALL return every credential row in the response regardless
of primary status. Each entry SHALL include `fingerprint`,
`duplicate_group_id`, and `is_primary` fields. Entries where `is_primary = true`
SHALL additionally include a `duplicates` array containing the
`{id, name, created_at, updated_at, status}` of every non-primary sibling in
the same group. `value_encrypted`, `access_token`, and any raw refresh-token
material MUST NOT appear at any nesting level.

#### Scenario: Primary entry nests its duplicates
- **GIVEN** the pool contains credentials "a" (primary), "b", and "c" in the
  same fingerprint group
- **WHEN** `GET /credentials` is called
- **THEN** the response entry for "a" has `is_primary = true` and
  `duplicates` listing objects for "b" and "c"
- **AND** the response also contains standalone entries for "b" and "c" with
  `is_primary = false` and no `duplicates` array

#### Scenario: Response omits refresh-token material
- **GIVEN** the pool contains any credential
- **WHEN** `GET /credentials` is serialized
- **THEN** no field anywhere in the JSON response equals or contains the raw
  refresh token, access token, or ciphertext bytes

### Requirement: The system SHALL support deleting credentials with orphan protection
The HTTP server SHALL expose `DELETE /credentials/{id}` which deletes a
credential row from the pool. If the row is `is_primary = true` AND its
duplicate group has more than one member, the endpoint SHALL reject the
request with HTTP 409 unless the caller supplies a `?promote=<other_id>` query
parameter naming another member of the same group. When `?promote=` is
supplied, the named sibling SHALL be promoted first (atomically within the
same transaction) and the original primary SHALL then be deleted. The endpoint
SHALL emit a `credential.deleted` audit log entry on success and SHALL require
a valid `X-Nexus-Secret` header.

#### Scenario: Delete a standalone credential
- **GIVEN** credential "a" has no duplicates (group size 1)
- **WHEN** `DELETE /credentials/a` is called with a valid secret header
- **THEN** the row is removed, the response is 204, and a
  `credential.deleted` audit entry is emitted

#### Scenario: Delete a non-primary sibling
- **GIVEN** credentials "a" (primary) and "b" (non-primary) share a group
- **WHEN** `DELETE /credentials/b` is called
- **THEN** "b" is removed, "a" retains `is_primary = true`, and the response is 204

#### Scenario: Reject deleting a primary with siblings
- **GIVEN** credentials "a" (primary), "b", and "c" share a group
- **WHEN** `DELETE /credentials/a` is called without a `promote` query param
- **THEN** the response is 409 with a body naming "b" and "c" as eligible
  promotion targets, and no rows are deleted

#### Scenario: Delete a primary with explicit promotion
- **GIVEN** credentials "a" (primary), "b", and "c" share a group
- **WHEN** `DELETE /credentials/a?promote=b` is called
- **THEN** "b" becomes `is_primary = true`, "a" is deleted, "c" remains
  `is_primary = false`, and a single `credential.deleted` audit entry is
  emitted with `detail.promoted_to = "b"`

#### Scenario: Reject DELETE without auth
- **WHEN** `DELETE /credentials/a` is called without a valid `X-Nexus-Secret`
  header
- **THEN** the server responds with HTTP 401 Unauthorized

### Requirement: The system SHALL support promoting a credential to primary within its group
The HTTP server SHALL expose `POST /credentials/{id}/promote` which marks the
given credential `is_primary = true` and atomically demotes the existing
primary of the same duplicate group to `is_primary = false`. The operation
SHALL be idempotent: promoting a credential that is already primary MUST
return 200 with no state change. The endpoint SHALL return 404 for an unknown
id and SHALL require a valid `X-Nexus-Secret` header. An audit log entry with
`event: "credential.promoted"` SHALL be emitted on every successful state
change (but not on no-op idempotent calls).

#### Scenario: Promote a non-primary sibling
- **GIVEN** credentials "a" (primary) and "b" (non-primary) share a group
- **WHEN** `POST /credentials/b/promote` is called
- **THEN** "b" becomes `is_primary = true`, "a" becomes `is_primary = false`,
  and a `credential.promoted` audit entry is emitted

#### Scenario: Promote an already-primary credential
- **GIVEN** credential "a" is already `is_primary = true`
- **WHEN** `POST /credentials/a/promote` is called
- **THEN** the response is 200, "a" remains primary, and no audit entry is
  emitted

#### Scenario: Unknown credential id
- **WHEN** `POST /credentials/missing/promote` is called
- **THEN** the response is 404

