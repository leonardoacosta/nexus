# session-context-api

## ADDED Requirements

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
validate `usedPercentage` is a finite number in `[0, 100]`; `contextWindowSize` when present MUST
be a positive integer. On success it MUST write/overwrite the in-memory entry for `:id` with the
current timestamp and return `204`; on an invalid body it MUST return `400` and leave the store
unchanged. No `x-nexus-secret` gate — reach is bounded at the bind layer (loopback + Tailscale
only), matching the ElevenLabs/integration-credentials route convention.

#### Scenario: Valid update
Given no prior entry exists for session "abc"
When `POST /sessions/abc/context` is called with `{usedPercentage: 15}`
Then the response is 204 and a subsequent GET returns `{usedPercentage: 15, ...}`

#### Scenario: Invalid body rejected
Given any prior state
When `POST /sessions/abc/context` is called with `{usedPercentage: "not-a-number"}`
Then the response is 400 and the store is unchanged

### Requirement: nx-agent MUST expose GET /sessions/:id/context to query the store
The endpoint MUST return `{ sessionId, usedPercentage, contextWindowSize, updatedAt }` (ISO 8601)
for a fresh entry, or `404 {"error": "no context data for session"}` for an absent or stale one.
It MUST be queryable by any caller reachable at the agent's bind address.

#### Scenario: Fresh session found
Given a fresh entry exists for session "abc"
When `GET /sessions/abc/context` is called
Then the response is 200 with the entry's current shape

#### Scenario: Unknown or stale session
Given no fresh entry exists for session "xyz"
When `GET /sessions/xyz/context` is called
Then the response is 404 `{"error": "no context data for session"}`
