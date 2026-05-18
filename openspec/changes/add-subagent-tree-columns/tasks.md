# Tasks: add-subagent-tree-columns

- [x] 1.1 Drizzle migration: ALTER TABLE sessions ADD parent_session_id (text FK), child_role (text)
- [x] 1.2 Drizzle migration: CREATE INDEX on (parent_session_id)
- [x] 1.3 Update agent dispatcher (routes/hooks.ts) to populate columns when agent_spawn event arrives
- [x] 1.4 Backfill script: replay `session_events` WHERE event_type='agent_spawn', UPDATE sessions
- [x] 1.5 Update `packages/core` types to surface the new columns
- [x] 1.6 Unit tests: parent-child linkage on agent_spawn dispatch
