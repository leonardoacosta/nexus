# session-context-api Specification

## Purpose
TBD - created by archiving change add-session-context-api. Update Purpose after archive.
## Requirements
### Requirement: nx-agent SHALL maintain an in-memory, session-id-keyed context-window store
The agent process SHALL maintain a new in-memory `Map<sessionId, { usedPercentage,
contextWindowSize, updatedAt }>`, mirroring `apps/agent/src/routes/elevenlabs-voices.ts`'s
cache-with-TTL pattern. Entries older than 600 seconds MUST be treated as absent. The store MUST
NOT be persisted to Postgres — ephemeral, per-render-frequency state with no historical-query
need.

#### Scenario: Fresh entry returned
Given a POST wrote `{usedPercentage: 42, contextWindowSize: 200000}` for session "abc" 30 seconds ago
When the store is queried for session "abc"
Then the entry is returned as fresh

#### Scenario: Stale entry treated as absent
Given a POST wrote an entry for session "abc" 700 seconds ago
When the store is queried for session "abc"
Then the entry is treated as absent (same as no entry ever existed)

### Requirement: nx-agent MUST expose POST /sessions/:id/context to update the store
The endpoint MUST accept `{ usedPercentage: number, contextWindowSize?: number }`. It MUST
validate `usedPercentage` is a finite number `>= 0`, with no upper bound —
`contextWindowSize` when present MUST be a positive integer. The upper bound was removed because
the producer's window heuristic (cc `telemetry.sh`, a model-keyed approximation of the real
context size) is not authoritative; real usage can legitimately exceed it, and rejecting values
above 100 silently discarded genuine over-window usage data (the bridge fails open on a `400`,
so the store simply never updates). On success it MUST write/overwrite the in-memory entry for
`:id` with the current timestamp and return `204`; on an invalid body it MUST return `400` and
leave the store unchanged. No `x-nexus-secret` gate — reach is bounded at the bind layer
(loopback + Tailscale only), matching the ElevenLabs/integration-credentials route convention.

#### Scenario: Valid update within the historical bound (unchanged)
Given no prior entry exists for session "abc"
When `POST /sessions/abc/context` is called with `{usedPercentage: 15}`
Then the response is 204 and a subsequent GET returns `{usedPercentage: 15, ...}`

#### Scenario: Valid update above 100 is now accepted
Given no prior entry exists for session "abc"
When `POST /sessions/abc/context` is called with `{usedPercentage: 175.0, contextWindowSize: 200000}`
Then the response is 204 and a subsequent GET returns `{usedPercentage: 175.0, contextWindowSize: 200000, ...}` — the value is preserved exactly, not truncated or rejected

#### Scenario: Invalid body rejected (unchanged)
Given any prior state
When `POST /sessions/abc/context` is called with `{usedPercentage: "not-a-number"}`
Then the response is 400 and the store is unchanged

#### Scenario: Negative usedPercentage is still rejected
Given any prior state
When `POST /sessions/abc/context` is called with `{usedPercentage: -5}`
Then the response is 400 and the store is unchanged — only the upper bound was relaxed

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

