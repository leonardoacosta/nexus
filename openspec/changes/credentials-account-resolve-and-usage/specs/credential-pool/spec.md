# credential-pool Delta

## ADDED Requirements

### Requirement: credential-usage-snapshot-columns
The `credentials` table MUST have seven nullable columns storing the latest Anthropic-side usage snapshot per credential: `usage_5h_used: integer`, `usage_5h_limit: integer`, `usage_5h_reset_at: timestamptz`, `usage_7d_used: integer`, `usage_7d_limit: integer`, `usage_7d_reset_at: timestamptz`, `usage_polled_at: timestamptz`. All MUST default to NULL so the migration is back-compat with existing rows.

#### Scenario: migration on existing data
- **Given** a `credentials` table with 12 existing rows (none with usage data)
- **When** the migration `0035_add_credential_usage_columns.sql` runs
- **Then** all 12 rows gain seven NULL columns; the migration completes without rewriting existing data

#### Scenario: insert without usage data
- **Given** the new schema is in place
- **When** a new credential row is inserted via `pool.add()`
- **Then** the row starts with all seven usage columns NULL; the poller fills them on its next tick

### Requirement: credential-usage-poller-service
The agent MUST start a `credential-usage-poller` service on boot that wakes every 5 minutes (configurable via `NEXUS_USAGE_POLL_INTERVAL_MS`), iterates `credentials` rows where `is_primary = true AND status = 'available'`, and calls `GET https://api.anthropic.com/api/oauth/usage` with the credential's decrypted access token. The poller MUST respect a concurrency cap of 4 simultaneous requests, MUST apply a 10-second per-call timeout, and MUST NEVER throw — errors are logged and counted only. When more than 50% of calls in a single tick fail, the next tick MUST be deferred to 30 minutes (back-off); the back-off MUST reset after a successful tick.

#### Scenario: successful poll updates row
- **Given** a valid credential `cred-123` with `is_primary = true`
- **When** the poller calls `/api/oauth/usage` and receives `{ five_hour: { used: 100, limit: 500, resets_at: "..." }, seven_day: { used: 1200, limit: 5000, resets_at: "..." } }`
- **Then** the credential row's `usage_5h_used = 100`, `usage_5h_limit = 500`, `usage_5h_reset_at` is set, the 7d fields are set, and `usage_polled_at` is the current time

#### Scenario: non-primary rows skipped
- **Given** three credential rows: `A` (is_primary=true), `B` (is_primary=false, sibling of A), `C` (is_primary=true)
- **When** the poller runs
- **Then** only A and C trigger `/api/oauth/usage` calls; B is skipped

#### Scenario: API failure does not clobber existing data
- **Given** `cred-123` has prior usage snapshot populated and `/api/oauth/usage` returns 500
- **When** the poller processes this credential
- **Then** the credential row's existing usage columns are UNCHANGED (no clobber to NULL); a counter increments; `usage_polled_at` is NOT updated

#### Scenario: high failure rate triggers back-off
- **Given** the current tick has 10 credentials and 6 calls return 500 (60% failure)
- **When** the tick completes
- **Then** the next scheduled tick is 30 minutes out instead of 5

#### Scenario: back-off resets after success
- **Given** the poller is in 30-minute back-off after a bad tick
- **When** the next tick succeeds (more than 50% calls return 200)
- **Then** the subsequent tick is scheduled at the normal 5-minute interval

### Requirement: refresh-identity-endpoints
The agent MUST expose two endpoints for triggering `probeIdentity()` on demand: `POST /credentials/:id/refresh-identity` (single credential) and `POST /credentials/refresh-identity-all` (every credential where `account_email IS NULL`). Both MUST decrypt the credential, call `https://api.anthropic.com/api/oauth/profile`, and update `account_email`, `account_name`, `account_uuid`, `org_name`, `org_uuid` on success. Both MUST be idempotent — calling them on an already-resolved credential MUST overwrite with the latest probe result, not error.

#### Scenario: single-credential refresh on a blank row
- **Given** `cred-789` has `account_email = NULL`
- **When** `POST /credentials/cred-789/refresh-identity` is called
- **Then** the probe runs, the row's identity fields are populated, the response is `200 { accountName, accountEmail, orgName, accountUuid, orgUuid }`

#### Scenario: single-credential refresh on already-resolved row
- **Given** `cred-456` already has `account_email = "leo@host"`
- **When** the endpoint is called again
- **Then** the probe runs again, overwrites with the latest (which may match), responds `200` with the current identity

#### Scenario: refresh-all skips non-blank rows
- **Given** 5 credentials total: 3 with NULL email, 2 with populated email
- **When** `POST /credentials/refresh-identity-all` is called
- **Then** exactly 3 probes are issued; the response is `200 { probed: 3, succeeded, failed }`

#### Scenario: probe failure surfaces in response
- **Given** the Anthropic profile endpoint returns 401 for a revoked credential
- **When** the single-credential endpoint is called against it
- **Then** the response is `502 { error: "anthropic profile probe failed", status: 401 }`; the credential row is UNCHANGED

### Requirement: dedupe-query-param-on-list
The `GET /credentials` endpoint MUST accept an optional `?dedupe=true` query parameter. When set, the response's `credentials[]` array MUST contain only rows with `is_primary = true`. Each returned row MUST include two additional fields: `siblingCount: number` (count of `is_primary = false` rows sharing the same `duplicate_group_id`) and `siblingIds: string[]` (their ids, sorted by `created_at` ascending). When the parameter is absent or `false`, the response MUST be byte-identical to today's shape — no `siblingCount` / `siblingIds` keys appear.

#### Scenario: dedupe collapses three rows into one
- **Given** three rows: `A` (primary, group X), `B` (sibling, group X), `C` (sibling, group X)
- **When** `GET /credentials?dedupe=true` is called
- **Then** the response's `credentials[]` contains ONE row (`A`) with `siblingCount: 2` and `siblingIds: ["B", "C"]`

#### Scenario: default behavior unchanged
- **When** `GET /credentials` is called (no query param)
- **Then** all three rows appear; no row has `siblingCount` or `siblingIds` fields

#### Scenario: dedupe with no duplicates
- **Given** three rows all with unique fingerprints, all `is_primary = true`
- **When** `GET /credentials?dedupe=true` is called
- **Then** all three rows appear; each has `siblingCount: 0` and `siblingIds: []`
