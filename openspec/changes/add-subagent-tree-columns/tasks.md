# Tasks: add-subagent-tree-columns

- [x] 1.1 Drizzle migration: ALTER TABLE sessions ADD parent_session_id (text FK), child_role (text)
- [x] 1.2 Drizzle migration: CREATE INDEX on (parent_session_id)
- [ ] 1.3 [deferred-to-nx-oh0j6] Update agent dispatcher (routes/hooks.ts) to populate columns when agent_spawn event arrives — dispatcher.ts agent_spawn case is log-only; wire-in lives with socket-dispatcher-parity refactor
- [x] 1.4 Backfill script: replay `session_events` WHERE event_type='agent_spawn', UPDATE sessions
- [x] 1.5 Update `packages/core` types to surface the new columns
- [ ] 1.6 [deferred-to-nx-oh0j6] Unit tests: parent-child linkage on agent_spawn dispatch — linkage test waits on wire-in; current test is no-op
