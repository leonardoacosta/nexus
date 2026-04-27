# session-persistence Specification (delta)

## ADDED Requirements

### Requirement: Sessions table populates total_cost_usd from session_summary

The SessionRegistry SHALL update `sessions.total_cost_usd` when a `session_summary` event is received that carries either an explicit `cost_usd` field OR sufficient token fields to compute cost server-side. The update SHALL be idempotent: a second `session_summary` for the same `session_id` SHALL OVERWRITE the prior value (last-write-wins for in-progress sessions; same value for completed sessions).

#### Scenario: First session_summary populates cost
- **GIVEN** session "abc" exists with `total_cost_usd=NULL`
- **WHEN** a `session_summary` event with `cost_usd: 12.50` arrives
- **THEN** `total_cost_usd` becomes `12.50`

#### Scenario: Second summary overwrites cost
- **GIVEN** session "abc" has `total_cost_usd=12.50`
- **WHEN** a second `session_summary` with `cost_usd: 18.75` arrives (e.g., session continued)
- **THEN** `total_cost_usd` becomes `18.75` (overwrite, not sum)

### Requirement: Stale active sessions get retired by date heuristic

After deployment of `restore-hooks-event-persistence`, a one-time cleanup SHALL UPDATE all sessions with `started_at < 2026-04-24` AND `status='active'` to set `status='ended'` and `ended_at=started_at + INTERVAL '8 hours'` (heuristic median session length). This retires the 147 sessions stranded by the regression. The cleanup SHALL run as a startup migration, idempotent if re-applied.

#### Scenario: Stranded sessions are retired
- **GIVEN** 147 sessions exist with `started_at < 2026-04-24` and `status='active'`
- **WHEN** the agent starts after the migration is deployed
- **THEN** all 147 sessions are updated: `status='ended'`, `ended_at` set to a heuristic value
- **AND** subsequent restarts do not re-modify these sessions (idempotent)

### Requirement: Per-turn token aggregates table (optional, future-proofing)

When token aggregation across multiple `session_summary` events is needed (e.g., for per-phase attribution downstream), nexus MAY introduce a `session_token_aggregates` table. The table SHALL contain columns `(session_id, turn_index, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd, recorded_at)` when implemented. This requirement is OPTIONAL for this change and the actual table creation MAY be deferred to a follow-up proposal once concrete per-phase use cases land.

#### Scenario: Per-turn aggregates can be queried (when implemented)
- **GIVEN** session "abc" has 5 `session_summary` events with rising token counts
- **WHEN** the per-turn aggregates feature is enabled
- **THEN** `SELECT SUM(output_tokens) FROM session_token_aggregates WHERE session_id='abc'` returns the cumulative count
- **AND** the most recent row reflects the latest summary
