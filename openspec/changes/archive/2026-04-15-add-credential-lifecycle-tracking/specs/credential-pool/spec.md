# credential-pool — Spec Delta

## MODIFIED Requirements

### Requirement: File watcher for credential directory

The agent MUST start a file watcher on `~/.config/nexus/credentials/` at boot. The watcher MUST handle three event types:

- **File created**: If the file matches `acct-*.json` and parses as valid JSON, call `pool.add()` to insert it. If the fingerprint already exists in the DB, treat as a metadata refresh instead.
- **File changed**: Re-read the file, compute fingerprint, and update metadata (expiresAt, subscriptionType, rateLimitTier, mcpProviders) for the matching DB row.
- **File deleted**: Log a warning. Do NOT delete the DB row — credential data is retained for audit purposes.

The watcher MUST debounce events by 200ms to avoid processing partial writes.

#### Scenario: new credential file detected
- **Given** the agent is running and watching `~/.config/nexus/credentials/`
- **When** a new file `acct-newacct.json` is created with a valid OAuth credential
- **Then** `pool.add()` is called within 2 seconds and the credential appears in `GET /credentials`

#### Scenario: credential file updated with fresh token
- **Given** credential `acct-abc.json` exists with `expiresAt` 2 hours ago
- **When** CC refreshes the OAuth token and rewrites the file with a new `expiresAt` 4 hours from now
- **Then** the DB row's `expiresAt` is updated to the new value within 2 seconds

#### Scenario: credential file deleted
- **Given** credential `acct-abc.json` exists in the watched directory
- **When** the file is deleted
- **Then** the DB row is NOT deleted and a warning is logged

#### Scenario: invalid file ignored
- **Given** a file `notes.txt` or `acct-broken.json` (invalid JSON) is created in the directory
- **When** the watcher processes the event
- **Then** no DB changes occur and a warning is logged

---

### Requirement: Credential lifecycle audit persistence

Every credential lifecycle event emitted by the pool MUST be persisted to the `credential_events` table in addition to the existing logger call. Events include: `leased`, `released`, `cooldown_entered`, `cooldown_exited`, `stale_lease_released`, `primary_swap`, `promoted`, `deleted`, `added`, `metadata_refreshed`.

#### Scenario: lease event persisted
- **Given** a credential is leased via `pool.lease()`
- **When** the lease completes successfully
- **Then** a row is inserted into `credential_events` with `event_type: 'leased'`, `credential_id`, `session_id` (from leasedBy), and `timestamp`

#### Scenario: rate limit event persisted
- **Given** a credential is rate-limited via `pool.reportRateLimit()`
- **When** the cooldown is set
- **Then** a row is inserted into `credential_events` with `event_type: 'cooldown_entered'`, `credential_id`, `session_id`, and `metadata: { cooldown_until }`
