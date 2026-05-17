# Tasks: add-subagent-tree-columns

- [ ] 1.1 Drizzle migration: ALTER TABLE sessions ADD parent_session_id (text FK), child_role (text)
- [ ] 1.2 Drizzle migration: CREATE INDEX on (parent_session_id)
- [ ] 1.3 Update `session-manager.ts` to populate columns when agent_spawn event arrives
- [ ] 1.4 Backfill script: replay `session_events` WHERE event_type='agent_spawn', UPDATE sessions
- [ ] 1.5 Update `packages/core` types to surface the new columns
- [ ] 1.6 Unit tests: parent-child linkage on agent_spawn dispatch
