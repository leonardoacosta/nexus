# credential-http-endpoint Specification

## Purpose
TBD - created by archiving change add-credential-mcp. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL expose credential pool status via HTTP

The agent's HTTP server (port 7401) SHALL serve `GET /credentials` which reads from the shared
`CredentialPool` in `AppState` and returns a JSON response containing account status, utilization
data, debounce state, and best-available recommendation. The response MUST NOT include
`access_token` or `path` fields. All time values MUST use relative formats (`seconds_ago`,
`resets_in_minutes`).

#### Scenario: Pool has multiple accounts with usage data
Given the credential pool contains accounts "personal" (active, 42% utilization) and "work" (55% utilization)
When `GET /credentials` is called
Then the response contains `active_account: "personal"`, both accounts in `accounts` array with correct utilization, and `best_available: "personal"`

#### Scenario: Pool is empty (passthrough mode)
Given the credential pool has no accounts loaded
When `GET /credentials` is called
Then the response contains `active_account: null`, `accounts: []`, `best_available: null`

#### Scenario: Debounce is active after recent swap
Given a credential swap occurred 60 seconds ago (within 180s debounce window)
When `GET /credentials` is called
Then `debounce_active` is `true` and `last_swap.seconds_ago` is approximately 60

#### Scenario: Response omits sensitive fields
Given the credential pool contains accounts with access tokens and file paths
When `GET /credentials` is called
Then the JSON response does not contain any `access_token` or `path` keys at any nesting level

