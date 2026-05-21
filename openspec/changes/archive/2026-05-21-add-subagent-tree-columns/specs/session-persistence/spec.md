## ADDED Requirements

### Requirement: sessions table SHALL carry sub-agent tree columns

The sessions schema SHALL include `parent_session_id` (text, nullable, references sessions.id) and `child_role` (text, nullable). An index SHALL be created on `parent_session_id` for tree queries.

#### Scenario: schema migration adds columns + index
- **GIVEN** a sessions table without the new columns
- **WHEN** the migration runs
- **THEN** both columns are added (NULL default) AND `idx_sessions_parent` index exists on `parent_session_id`

### Requirement: agent_spawn events SHALL populate tree columns

When an `agent_spawn` hook event arrives, the session manager SHALL extract `parent_agent` and `child_role` from the payload and persist them to the spawned session's row.

#### Scenario: child session linked to parent
- **GIVEN** session `oo-7f3a` exists and CC fires `agent_spawn` with `{session_id: 'oo-7f3a-child-01', parent_agent: 'oo-7f3a', child_role: 'Explore'}`
- **WHEN** the dispatcher processes the event
- **THEN** the `oo-7f3a-child-01` sessions row has `parent_session_id='oo-7f3a'` and `child_role='Explore'`

### Requirement: backfill script SHALL populate existing rows

A one-shot migration script SHALL replay all `session_events` WHERE `event_type='agent_spawn'`, extract `parent_agent` + `child_role`, and UPDATE the corresponding sessions row.

#### Scenario: tree query returns sub-agents
- **GIVEN** session `oo-7f3a` spawned 3 sub-agents (backfilled into the new columns)
- **WHEN** `SELECT id, child_role FROM sessions WHERE parent_session_id = 'oo-7f3a'`
- **THEN** returns 3 rows with their respective child roles
