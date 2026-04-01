# Capability: Credential Analytics

## ADDED Requirements

### Requirement: The system MUST persist credential usage polls and swap events to SQLite
The credential pool MUST write per-account utilization to `credential_polls` on each 5-minute poll, replacing `usage-cache.json`. The rate limit interceptor MUST log swap events to `credential_swaps` with from/to account and trigger session.

#### Scenario: Usage poll persisted
Given 2 credential accounts are registered
When the 5-minute usage poll completes
Then 2 rows are inserted into credential_polls with account name, 5h/7d utilization, and timestamp

#### Scenario: Credential swap logged
Given a rate limit triggers rotation from "personal" to "work" for session "abc"
When the swap completes
Then a row is inserted into credential_swaps with from="personal", to="work", session="abc"

#### Scenario: usage-cache.json eliminated
Given the credential pool previously wrote to ~/.config/nexus/state/usage-cache.json
When the v2 migration is active
Then the pool reads/writes usage data from SQLite only, and the JSON cache file is no longer written
