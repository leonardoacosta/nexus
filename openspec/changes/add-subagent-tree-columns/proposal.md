# Proposal: Add sub-agent tree columns to sessions schema

## Change ID
`add-subagent-tree-columns`

## Phase
P2 cc-integration (parent: spine-migration · nx-ma6h8 · feature: nx-hkfu3)

## Summary
Add `parent_session_id` and `child_role` columns to the sessions table; backfill from existing `agent_spawn` events in `session_events.metadata`.

## Context
- Modifies: `packages/db/src/schema/sessions.ts` (+2 columns)
- Migration: Drizzle migration with backfill query
- Modifies: `apps/agent/src/session-manager.ts` (populate on agent_spawn events)
- Related: TUI / Swift dashboard tree-rendering work (P4 / P5)

## Motivation
Hook payloads already carry `parent_agent`, `child_role`, `agent_type`, `agent_name`, `is_subagent` on `agent_spawn` events. The dispatcher persists them to `session_events.metadata` but never normalizes them onto the sessions table. Result: no queryable "sub-agents spawned by session X" relationship.

## Requirements

### Requirement: sessions table SHALL carry parent + role columns

Add `parent_session_id` (text, nullable, references sessions.id) and `child_role` (text, nullable) to the sessions schema. Index on `parent_session_id` for tree queries.

### Requirement: backfill SHALL populate existing rows

A one-shot migration script SHALL read all `agent_spawn` events from `session_events`, extract `parent_agent` + `child_role`, and UPDATE the corresponding sessions row.

#### Scenario: query a session's sub-agents
- **GIVEN** session `oo-7f3a` spawned 3 sub-agents (recorded as agent_spawn events)
- **WHEN** `SELECT * FROM sessions WHERE parent_session_id = 'oo-7f3a'`
- **THEN** returns 3 rows with their respective `child_role` values
