## MODIFIED Requirements

### Requirement: nx-agent MUST expose GET /sessions/:id/context to query the store

The endpoint MUST return `{ sessionId, usedPercentage, contextWindowSize, updatedAt, model }`
(ISO 8601 `updatedAt`) for a fresh entry, or `404 {"error": "no context data for session"}` for an
absent or stale one. It MUST be queryable by any caller reachable at the agent's bind address.
`model` is the derived single-letter model-family tag (`modelFamilyLetter`, `@nexus/core`) for the
session's currently persisted `sessions.model` value, looked up fresh on every request — not
cached in the in-memory context-window entry. `model` MUST be `null` (never an error) when the
session has no persisted `model` value, when no matching session row exists, or when the database
is unavailable.

#### Scenario: Fresh session found, with a known model

Given a fresh entry exists for session "abc"
And session "abc"'s persisted `sessions.model` is `"claude-opus-4-8"`
When `GET /sessions/abc/context` is called
Then the response is 200 with `model: "O"` alongside the existing fields

#### Scenario: Fresh session found, no persisted model

Given a fresh entry exists for session "abc"
And session "abc" has no matching row in `sessions`, or its `model` column is null
When `GET /sessions/abc/context` is called
Then the response is 200 with `model: null` and the existing fields unchanged

#### Scenario: Unknown or stale session

Given no fresh entry exists for session "xyz"
When `GET /sessions/xyz/context` is called
Then the response is 404 `{"error": "no context data for session"}`
