## MODIFIED Requirements

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

## ADDED Requirements

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
