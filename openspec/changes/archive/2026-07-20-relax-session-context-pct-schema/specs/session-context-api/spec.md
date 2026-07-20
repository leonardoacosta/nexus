## MODIFIED Requirements

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
