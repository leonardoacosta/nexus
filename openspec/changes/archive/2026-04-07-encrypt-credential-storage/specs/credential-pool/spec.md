## MODIFIED Requirements

### Requirement: The system SHALL manage credential files
The agent MUST discover and parse OAuth credential files from `~/.config/nexus/credentials/`.
The usage-cache file `~/.config/nexus/state/usage-cache.json` MUST be written with `0o600`
file permissions, consistent with pool credential files.

#### Scenario: Startup with credentials directory
Given the directory `~/.config/nexus/credentials/` contains `acct-personal.json` and `acct-work.json`
When the agent starts
Then it parses both files and registers two `CredentialAccount` entries with name, path, and access_token

#### Scenario: Startup without credentials directory
Given `~/.config/nexus/credentials/` does not exist
When the agent starts
Then the credential pool operates in passthrough mode with zero accounts and no interception

#### Scenario: Credential file added at runtime
Given the agent is running with one credential
When a new file `acct-team.json` is created in the credentials directory
Then the watcher detects the change and adds the new account to the pool within 2 seconds

#### Scenario: Credential file removed at runtime
Given the agent is running with three credentials and `acct-team.json` is the active credential
When `acct-team.json` is deleted from the credentials directory
Then the account is removed from the pool and the symlink is swapped to the next best account

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

## ADDED Requirements

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
The lease selection MUST prefer credentials with lower historical rate-limit frequency. Available
credentials of the requested type MUST be ordered by `rate_limit_count ASC` (then `leased_at ASC
NULLS FIRST`) so that credentials that have triggered fewer rate limits are leased first.
`reportRateLimit` MUST increment `rate_limit_count` on the affected credential.

#### Scenario: Prefer credential with fewer rate limits
Given credentials "A" (rate_limit_count=0) and "B" (rate_limit_count=3) are both available with type "oauth"
When `POST /credentials/lease` is called with type "oauth"
Then credential "A" is leased

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
