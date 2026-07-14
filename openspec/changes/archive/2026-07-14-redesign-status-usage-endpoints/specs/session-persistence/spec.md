## MODIFIED Requirements

### Requirement: GET /statusline surfaces a live model letter and composed session/account status

`GET /statusline` SHALL derive each session's `model` field in its response from the session
row's stored (raw) model value via the shared single-letter family mapping, rather than the
literal `null` it returned before `add-session-model-authority`. In addition, `GET /statusline`
SHALL accept optional `sessionId` and `accountId` query parameters, mutually exclusive, that
narrow the response to a single-entity composed status view:

- Neither param present: today's existing response (`sessions[]`, `git`, `machine`,
  `uptime_seconds`) is returned unchanged.
- `accountId` present, `sessionId` absent: the response is `{ account: Account5H7D }` — that
  account's 5-hour and 7-day Anthropic usage windows (`used`, `limit`, `resetsAt` for each),
  sourced from `credentials.usage5hUsed/Limit/ResetAt` and `usage7dUsed/Limit/ResetAt`. 404 when
  the account id is unknown.
- `sessionId` present, `accountId` absent: the response is `{ session: SessionStatus }`,
  composing: the session's model letter; its active credential's 5H/7D usage windows (via
  `sessions.credentialId`), null when unresolved; per-session cost usage from
  `readSessionCostTokens` (VictoriaMetrics-backed, per `cc-telemetry-read`); per-session-project
  beads/openspec/git status resolved via `sessions.projectId -> projects.name ->
  project_status_snapshots` latest row (null when the session has no resolvable project); and the
  next-action recommendation (same computation `GET /recommend` performed). 404 when the session
  id is unknown.
- Both params present: `400 { error: "sessionId and accountId are mutually exclusive" }`.

#### Scenario: Session with a captured model returns its letter (unchanged base behavior)

- **GIVEN** a session row whose `model` column holds `"claude-opus-4-8"`
- **WHEN** a client requests `GET /statusline` with no query params
- **THEN** that session's entry in the `sessions[]` response has `model: "O"`

#### Scenario: Session with no captured model returns null

- **GIVEN** a session row whose `model` column is `null` or empty
- **WHEN** a client requests `GET /statusline` with no query params
- **THEN** that session's entry has `model: null`

#### Scenario: accountId mode returns 5H/7D usage for one account

- **GIVEN** account "acct-1" has `usage5hUsed=30, usage5hLimit=50` and
  `usage7dUsed=200, usage7dLimit=500`
- **WHEN** a client requests `GET /statusline?accountId=acct-1`
- **THEN** the response is `200 { account: { accountId: "acct-1", fiveHour: { used: 30, limit: 50, ... }, sevenDay: { used: 200, limit: 500, ... } } }`

#### Scenario: accountId mode 404s on unknown account

- **GIVEN** no credential row with id "ghost" exists
- **WHEN** a client requests `GET /statusline?accountId=ghost`
- **THEN** the response status is 404

#### Scenario: sessionId mode composes model, usage, cost, and project status

- **GIVEN** session "s1" has `model="claude-sonnet-5"`, `credentialId="acct-1"`, and
  `projectId` resolving to project "nexus" with a `project_status_snapshots` row
  `{ beadsReadyUnlinked: 3, beadsBlockedUnlinked: 1, proposalsUnarchived: 2 }`
- **WHEN** a client requests `GET /statusline?sessionId=s1`
- **THEN** the response is `200` with `session.model === "S"`, `session.fiveHour`/`sevenDay`
  populated from account "acct-1", `session.project.beadsReadyUnlinked === 3`, and
  `session.usage.cost_usd` populated from `readSessionCostTokens`

#### Scenario: sessionId mode 404s on unknown session

- **GIVEN** no session with id "missing" exists
- **WHEN** a client requests `GET /statusline?sessionId=missing`
- **THEN** the response status is 404

#### Scenario: sessionId mode with unresolvable project returns null project status

- **GIVEN** session "s2" has `projectId=null`
- **WHEN** a client requests `GET /statusline?sessionId=s2`
- **THEN** the response is `200` with `session.project === null`

#### Scenario: Both params rejected

- **WHEN** a client requests `GET /statusline?sessionId=s1&accountId=acct-1`
- **THEN** the response is `400 { error: "sessionId and accountId are mutually exclusive" }`

### Requirement: Model family letter mapping is a single shared implementation

The system SHALL define the model-id/display-name to single-letter family mapping (fable,
opus, sonnet, haiku mapping to F, O, S, H respectively; an unknown family falling back to the
uppercased display-name initial; no model producing null) in exactly one shared location,
`packages/core`, consumed by both the agent's server-side derivation and any client-side
renderer, rather than duplicated per consumer.

#### Scenario: Agent and statusline renderer agree on the same letter

- **GIVEN** a model value `"claude-sonnet-5"`
- **WHEN** both `GET /statusline`'s server-side derivation and `apps/nexus-statusline`'s
  client-side renderer compute a family letter for it
- **THEN** both SHALL produce `"S"` via the same shared `packages/core` function, not two
  independently-maintained implementations

## REMOVED Requirements

### Requirement: Sessions table populates total_cost_usd from session_summary

**Reason**: This requirement documented an approach (populating `sessions.total_cost_usd` from a
`session_summary` hook event) that was superseded by the VictoriaMetrics-backed telemetry read
path (`cc-telemetry-read` capability, `readSessionCostTokens`) before it was ever fully wired —
every write site in the current codebase sets this column to `null` unconditionally. The column
never held a real value in production.

**Migration**: The `sessions.total_cost_usd` column and its dead write sites are dropped (task
1.1). Callers needing per-session cost now use `GET /statusline?sessionId=` (this proposal) or
the retiring `GET /sessions/{id}/tokens` route directly during the migration window.
