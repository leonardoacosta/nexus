# credential-http-endpoint Specification

## Purpose
TBD - created by archiving change add-credential-mcp. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL expose credential pool status via HTTP

The agent's HTTP server (port 7401) SHALL serve `GET /credentials` which reads from the shared
`CredentialPool` in `AppState` and returns a JSON response containing account status, utilization
data, debounce state, and best-available recommendation. The response MUST NOT include
`access_token` or `path` fields. All time values MUST use relative formats (`seconds_ago`,
`resets_in_minutes`). All credential endpoints (`GET /credentials`, `POST /credentials`,
`POST /credentials/lease`, `POST /credentials/{id}/release`,
`POST /credentials/{id}/report-rate-limit`, `GET /credentials/status`) SHALL require a valid
`X-Nexus-Secret` header; requests without a valid secret SHALL be rejected with HTTP 401 by the
global auth middleware before the credential handler is reached.

#### Scenario: Pool has multiple accounts with usage data
Given the credential pool contains accounts "personal" (active, 42% utilization) and "work" (55% utilization)
When `GET /credentials` is called with a valid `X-Nexus-Secret` header
Then the response contains `active_account: "personal"`, both accounts in `accounts` array with correct utilization, and `best_available: "personal"`

#### Scenario: Pool is empty (passthrough mode)
Given the credential pool has no accounts loaded
When `GET /credentials` is called with a valid `X-Nexus-Secret` header
Then the response contains `active_account: null`, `accounts: []`, `best_available: null`

#### Scenario: Debounce is active after recent swap
Given a credential swap occurred 60 seconds ago (within 180s debounce window)
When `GET /credentials` is called with a valid `X-Nexus-Secret` header
Then `debounce_active` is `true` and `last_swap.seconds_ago` is approximately 60

#### Scenario: Response omits sensitive fields
Given the credential pool contains accounts with access tokens and file paths
When `GET /credentials` is called with a valid `X-Nexus-Secret` header
Then the JSON response does not contain any `access_token` or `path` keys at any nesting level

#### Scenario: Unauthenticated request to credential endpoint
- **WHEN** `GET /credentials`, `POST /credentials`, `POST /credentials/lease`, or any other credential endpoint is called without a valid `X-Nexus-Secret` header
- **THEN** the server responds with HTTP 401 Unauthorized and the credential handler is never invoked

### Requirement: Credential Submission TLS Enforcement
When the `NEXUS_REQUIRE_TLS` environment variable is set to `true`, the agent SHALL reject
`POST /credentials` requests that arrive without TLS. TLS presence is determined by the
`x-forwarded-proto: https` header set by a reverse proxy (e.g. Traefik). Rejected requests
receive HTTP 403 with the message `"credentials must be submitted over TLS"`. When
`NEXUS_REQUIRE_TLS` is not set or is `false`, the agent permits credential submission over
plain HTTP to support localhost-only development deployments.

#### Scenario: TLS enforced and request arrives over HTTPS
- **WHEN** `NEXUS_REQUIRE_TLS=true` and the request carries `x-forwarded-proto: https`
- **THEN** the credential is accepted and the handler proceeds normally

#### Scenario: TLS enforced and request arrives over plain HTTP
- **WHEN** `NEXUS_REQUIRE_TLS=true` and the request does not carry `x-forwarded-proto: https`
- **THEN** the server responds with HTTP 403 and message `"credentials must be submitted over TLS"`

#### Scenario: TLS not enforced (default)
- **WHEN** `NEXUS_REQUIRE_TLS` is unset or `false`
- **THEN** `POST /credentials` is accepted regardless of the presence of `x-forwarded-proto`

### Requirement: Credential Access Audit Trail

The system SHALL emit a structured audit log entry on every credential access
event that decrypts or probes a credential secret. Audit entries MUST be
emitted at the HTTP handler layer (not the pool layer) so that caller context
(IP address, actor identity) is captured. Each audit entry MUST include:
`event` (string), `credential_id` (string), `actor` (string), `ip` (string),
`timestamp_iso` (ISO 8601 string), and an optional `detail` object.

The audit logger MUST use a dedicated child logger named `audit.credential`
created via `createLogger("audit.credential")` so that audit entries can be
filtered and forwarded independently of operational logs.

#### Scenario: Successful lease emits audit entry

- **WHEN** `POST /credentials/lease` succeeds and returns a decrypted credential
- **THEN** an audit log entry is emitted with `event: "credential.leased"`,
  `credential_id` matching the leased credential, `actor` matching the
  `leased_by` value from the request body, and `ip` from the caller's address

#### Scenario: Rate-limit auto-swap emits two audit entries

- **WHEN** `POST /credentials/{id}/report-rate-limit` triggers a cooldown and
  the pool returns a replacement credential
- **THEN** two audit entries are emitted: one with
  `event: "credential.cooldown"` for the rate-limited credential and one with
  `event: "credential.auto_swap"` for the replacement, linking both via a
  `detail.replaced_credential_id` field

#### Scenario: Rate-limit with no replacement emits single audit entry

- **WHEN** `POST /credentials/{id}/report-rate-limit` triggers a cooldown but
  no replacement credential is available
- **THEN** only one audit entry is emitted with
  `event: "credential.cooldown"` and no `credential.auto_swap` entry

#### Scenario: Health check emits audit entry

- **WHEN** `GET /credentials/{id}/health` decrypts and probes a credential
- **THEN** an audit log entry is emitted with
  `event: "credential.health_check"`, `credential_id`, `ip`, and
  `detail.healthy` reflecting the probe result

#### Scenario: Audit entries include caller IP

- **WHEN** a credential access request arrives with an `x-forwarded-for` header
- **THEN** the audit entry `ip` field contains the first address from that
  header
- **WHEN** no `x-forwarded-for` header is present
- **THEN** the audit entry `ip` field contains the direct socket peer address

