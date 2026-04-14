## ADDED Requirements

### Requirement: The system MUST persist per-session per-turn token usage

The agent SHALL insert one row into a `session_token_turns` table for every
parsed turn of every tracked session. Each row MUST include: `id` (PK),
`session_id` (FK to `sessions.id`), `ts` (turn timestamp from the transcript
JSONL), `model`, `service_tier`, `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `cost_usd` (nullable),
`credential_id` (FK to `credentials.id`, nullable), and `credential_fingerprint`
(nullable). The table SHALL enforce `UNIQUE(session_id, ts)` as a dedup safety
net for re-reads after agent restart. The table SHALL have indexes on
`(credential_fingerprint, ts)` for credential rollups and on `(session_id)` for
session detail queries.

#### Scenario: Turn row includes all usage fields
- **GIVEN** a transcript line with `message.usage = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, service_tier: "standard" }` and `message.model = "claude-opus-4"`
- **WHEN** the tail watcher parses the line
- **THEN** a `session_token_turns` row is inserted with all five usage values and model/service_tier populated

#### Scenario: Duplicate turn on resume is rejected silently
- **GIVEN** a `session_token_turns` row already exists for `(session_id = "s1", ts = "2026-04-14T12:00:00Z")`
- **WHEN** the watcher re-reads the same transcript line after an agent restart
- **THEN** the `UNIQUE(session_id, ts)` constraint rejects the insert
- **AND** the error is caught and logged at DEBUG level, not propagated

#### Scenario: Turn row without usage is skipped
- **GIVEN** a transcript line with no `message.usage` field (e.g. a system message)
- **WHEN** the tail watcher parses the line
- **THEN** no row is inserted and parsing continues to the next line

### Requirement: Turn rows MUST be attributed to the credential active at the turn timestamp

At turn-insert time the agent SHALL resolve the credential in effect for
`(session_id, turn.ts)` by querying
`credential_swaps WHERE session_id = ? AND swapped_at <= turn.ts ORDER BY
swapped_at DESC LIMIT 1`. When no swap row matches, the agent SHALL fall back
to `sessions.credential_id` (the initial lease captured at `session_start`).
The resolved `credential_id` and its denormalized `credential_fingerprint` MUST
be written onto the turn row immediately and SHALL NOT be retroactively
updated.

#### Scenario: Pre-swap turn attaches to initial credential
- **GIVEN** session "s1" started with `credential_id = "c1"` (`fp-a`) and has a `credential_swaps` row `{from: "c1", to: "c2", swapped_at: "12:05"}`
- **WHEN** a turn at `ts = "12:03"` is inserted
- **THEN** the turn row has `credential_id = "c1"` and `credential_fingerprint = "fp-a"`

#### Scenario: Post-swap turn attaches to swap target
- **GIVEN** the same session and swap history
- **WHEN** a turn at `ts = "12:07"` is inserted
- **THEN** the turn row has `credential_id = "c2"` and `credential_fingerprint = "fp-b"`

#### Scenario: Session with no swaps falls back to initial credential
- **GIVEN** session "s2" started with `credential_id = "c3"` and has zero `credential_swaps` rows
- **WHEN** any turn is inserted
- **THEN** the turn row has `credential_id = "c3"` and the fingerprint of "c3"

#### Scenario: Retro-attribution is not performed
- **GIVEN** a turn was inserted with `credential_id = "c1"` at `ts = "12:04:59"`
- **WHEN** a swap row `{from: "c1", to: "c2", swapped_at: "12:04:58"}` is committed afterwards
- **THEN** the already-inserted turn row still shows `credential_id = "c1"`
- **AND** no background process re-maps the row

### Requirement: The system MUST compute per-turn cost from a hardcoded model price table

The agent SHALL maintain a typed model price table at
`apps/agent/src/credentials/model-pricing.ts` mapping each known Anthropic
model to `{input_rate, output_rate, cache_read_rate, cache_creation_rate}`
USD-per-token values. Cost SHALL be computed as
`input_tokens*input_rate + output_tokens*output_rate +
cache_read_input_tokens*cache_read_rate +
cache_creation_input_tokens*cache_creation_rate`. When the turn's model is not
present in the table, `cost_usd` SHALL be NULL and a WARN-level log SHALL be
emitted once per `(session_id, model)` pair.

#### Scenario: Known model produces deterministic cost
- **GIVEN** `model-pricing.ts` includes `"claude-opus-4"` with rates `{input_rate: 15e-6, output_rate: 75e-6, cache_read_rate: 1.5e-6, cache_creation_rate: 18.75e-6}`
- **WHEN** a turn with `input_tokens = 1000, output_tokens = 500, cache_read_input_tokens = 0, cache_creation_input_tokens = 0, model = "claude-opus-4"` is inserted
- **THEN** `cost_usd = 0.0525`

#### Scenario: Unknown model yields NULL cost and warn-once log
- **GIVEN** the turn's model is `"claude-future-99"` which is NOT in the price table
- **WHEN** the cost calculator runs
- **THEN** the inserted row has `cost_usd = NULL`
- **AND** a WARN log is emitted with the model name and session ID
- **AND** subsequent turns of the same `(session_id, model)` pair do NOT re-emit the WARN

### Requirement: The system SHALL expose GET /sessions/{id}/tokens

The agent HTTP server SHALL expose `GET /sessions/{id}/tokens` returning a
JSON body `{ turns: [...], aggregates: { input_tokens, output_tokens,
cache_creation_input_tokens, cache_read_input_tokens, cost_usd, turn_count } }`.
The `turns` array SHALL contain all `session_token_turns` rows for the given
session ordered by `ts ASC`. The `aggregates` object SHALL be computed from
the same rows.

#### Scenario: Returns turns and aggregates for tracked session
- **GIVEN** session "s1" has 5 turns totaling 12000 input / 4000 output tokens
- **WHEN** `GET /sessions/s1/tokens` is called
- **THEN** the response is 200 with a `turns` array of length 5 and `aggregates.input_tokens = 12000`, `aggregates.output_tokens = 4000`, `aggregates.turn_count = 5`

#### Scenario: Unknown session returns 404
- **GIVEN** no session with id "missing" exists
- **WHEN** `GET /sessions/missing/tokens` is called
- **THEN** the response status is 404

#### Scenario: Session with no tracked turns returns empty aggregates
- **GIVEN** session "s2" exists but has no `session_token_turns` rows (watcher never attached)
- **WHEN** `GET /sessions/s2/tokens` is called
- **THEN** the response is 200 with `turns = []` and all aggregate fields equal to 0

### Requirement: The system SHALL expose GET /credentials/{id}/usage with time-window rollups

The agent HTTP server SHALL expose `GET /credentials/{id}/usage?window=<W>`
returning `{ input_tokens, output_tokens, cache_creation_input_tokens,
cache_read_input_tokens, cost_usd, turn_count, session_count }` computed from
`session_token_turns` rows filtered by the target credential's `fingerprint`
(NOT its `credential_id`, so duplicate-group members roll up together) and by
`ts >= now() - window`. Supported window values SHALL be `1h`, `6h`, `24h`,
and `7d`. An unrecognized `window` value SHALL return HTTP 400.

#### Scenario: Rollup aggregates across duplicate group
- **GIVEN** credentials "c1" and "c2" share `fingerprint = "fp-a"` (duplicate group)
- **AND** `session_token_turns` has 4 rows attributed to "c1" and 6 rows attributed to "c2" within the last 24h
- **WHEN** `GET /credentials/c1/usage?window=24h` is called
- **THEN** the response aggregates all 10 rows (both "c1" and "c2" contributions)
- **AND** `turn_count = 10`

#### Scenario: Window filters old data
- **GIVEN** a turn was inserted 30 hours ago with `credential_fingerprint = "fp-a"`
- **WHEN** `GET /credentials/c1/usage?window=24h` is called on credential with fingerprint "fp-a"
- **THEN** the old turn is excluded from the aggregate

#### Scenario: Invalid window returns 400
- **WHEN** `GET /credentials/c1/usage?window=2d` is called
- **THEN** the response status is 400 with a JSON error naming the allowed window values

#### Scenario: Unknown credential returns 404
- **GIVEN** no credential with id "missing" exists
- **WHEN** `GET /credentials/missing/usage?window=24h` is called
- **THEN** the response status is 404

### Requirement: The system SHALL emit token.turn events on the notification bus

After each successful insert batch from the tail watcher, the agent SHALL emit
a `token.turn` event on the existing notification/socket bus with payload
`{session_id, credential_id, credential_fingerprint, tokens_delta, cost_delta}`
where `tokens_delta` is the sum of input+output+cache_creation+cache_read
tokens in the batch and `cost_delta` is the sum of `cost_usd` across the
batch (NULL contributions count as 0). The event stream is append-only: the
agent SHALL NOT replay historical events on reconnection.

#### Scenario: Batch insert produces one token.turn event
- **GIVEN** the tail watcher parses and inserts 3 turns in one batch
- **WHEN** the batch commits
- **THEN** exactly one `token.turn` event is emitted with `tokens_delta` equal to the sum of all five token fields across the 3 rows

#### Scenario: Event includes attributed credential
- **GIVEN** a batch of turns all attributed to credential "c1" (`fp-a`)
- **WHEN** the `token.turn` event is emitted
- **THEN** the payload includes `credential_id = "c1"` and `credential_fingerprint = "fp-a"`

#### Scenario: NULL cost contributions are zero in cost_delta
- **GIVEN** a batch contains 2 turns with computed `cost_usd` and 1 turn with `cost_usd = NULL` (unknown model)
- **WHEN** the `token.turn` event is emitted
- **THEN** `cost_delta` equals the sum of the 2 non-null turns only
