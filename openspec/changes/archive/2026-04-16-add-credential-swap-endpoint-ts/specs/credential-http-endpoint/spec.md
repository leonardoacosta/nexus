## ADDED Requirements

### Requirement: POST /credentials/swap — manual credential account switch

The agent HTTP server SHALL expose `POST /credentials/swap` which accepts
`{ "to": "<name>" }`, looks up the primary credential matching that name,
parks the current best-available credential on a timed cooldown (without
incrementing `rateLimitCount`), and returns the updated credential pool status.
The endpoint SHALL require a valid `X-Nexus-Secret` header enforced by the
existing global auth middleware.

#### Scenario: Successful swap to named account
Given the pool contains credentials "personal" (available, rateLimitCount=0) and "work" (available, rateLimitCount=0), and "personal" is currently best-available
When `POST /credentials/swap` is called with body `{ "to": "work" }` and a valid `X-Nexus-Secret` header
Then "personal" is set to cooldown status without incrementing its rateLimitCount, and the response includes the updated pool list showing "work" as available and "personal" as cooldown

#### Scenario: Target credential not found
Given the pool contains credential "personal" but not "staging"
When `POST /credentials/swap` is called with body `{ "to": "staging" }`
Then the server responds with HTTP 404

#### Scenario: Target credential already in cooldown
Given the pool contains credential "work" with status "cooldown"
When `POST /credentials/swap` is called with body `{ "to": "work" }`
Then the server responds with HTTP 409

#### Scenario: Target is already best-available (no-op)
Given the pool contains only one available credential named "personal" with rateLimitCount=0 and status="available"
When `POST /credentials/swap` is called with body `{ "to": "personal" }`
Then the server responds with HTTP 200 and parked is null in the response body (no credential was parked)

#### Scenario: Swap emits audit entries
Given the pool contains "personal" (best-available) and "work" (available)
When `POST /credentials/swap` is called with body `{ "to": "work" }`
Then two audit log entries are emitted: one with event "credential.manual_swap_out" for "personal" and one with event "credential.manual_swap_in" for "work"
