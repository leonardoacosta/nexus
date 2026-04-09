## ADDED Requirements

### Requirement: The system SHALL swap credentials via HTTP POST

The agent's HTTP server SHALL expose `POST /credentials/swap` which accepts a JSON body
`{ "account": "<name>" }` and triggers a credential swap to the named account. The endpoint
SHALL require a valid `X-Nexus-Secret` header. On success, it SHALL call the existing
`swap_credential()` and `record_swap()` methods, update the active account, and return the
full credential pool status with the swapped account name. The response MUST NOT include
`access_token` or `path` fields.

#### Scenario: Successful swap to named account
- **WHEN** `POST /credentials/swap` is called with `{ "account": "work" }` and a valid `X-Nexus-Secret` header
- **AND** the account "work" exists in the pool and is not expired
- **AND** no debounce window is active
- **THEN** the active credential symlink is swapped to "work", `record_swap("work")` is called, and the response contains `swapped_to: "work"` with the full updated `CredentialsResponse` (active_account, accounts, swap state)

#### Scenario: Account not found
- **WHEN** `POST /credentials/swap` is called with `{ "account": "nonexistent" }`
- **THEN** the server responds with HTTP 404 and message `"account 'nonexistent' not found in pool"`

#### Scenario: Account expired
- **WHEN** `POST /credentials/swap` is called with `{ "account": "old-acct" }`
- **AND** the account "old-acct" exists but `is_expired()` returns true
- **THEN** the server responds with HTTP 409 and message `"account 'old-acct' is expired"`

#### Scenario: Debounce window active
- **WHEN** `POST /credentials/swap` is called within 180 seconds of the last swap
- **THEN** the server responds with HTTP 429 and a JSON body containing `retry_after_seconds` indicating the remaining debounce time

#### Scenario: Swap failure
- **WHEN** `POST /credentials/swap` is called with a valid account
- **AND** `swap_credential()` returns an error (e.g., filesystem failure)
- **THEN** the server responds with HTTP 500 and the error message

#### Scenario: Unauthenticated swap request
- **WHEN** `POST /credentials/swap` is called without a valid `X-Nexus-Secret` header
- **THEN** the server responds with HTTP 401 Unauthorized
