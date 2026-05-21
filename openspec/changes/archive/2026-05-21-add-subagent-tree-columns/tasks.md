# Tasks: add-subagent-tree-columns

- [x] 1.1 Drizzle migration: ALTER TABLE sessions ADD parent_session_id (text FK), child_role (text)
- [x] 1.2 Drizzle migration: CREATE INDEX on (parent_session_id)
- [x] 1.3 Update agent dispatcher to populate columns on agent_spawn — done via `services/process-hook-event.ts` (nx-oh0j6). Dispatcher's `agent_spawn` case now invokes the helper, which extracts `parent_session_id` (or back-compat `parent_agent`) and `child_role` from the payload and calls `SessionManager.updateLinkage()`. The new `updateLinkage` method patches the in-memory `Session` row and triggers a write-through to persist both columns. `AgentSpawnEvent` socket type extended with `parent_session_id`, `parent_agent`, and `child_role` fields. `sessions.parent_session_id` + `child_role` now included in `sessionToRow` so future upserts persist them.
- [x] 1.4 Backfill script: replay `session_events` WHERE event_type='agent_spawn', UPDATE sessions
- [x] 1.5 Update `packages/core` types to surface the new columns
- [x] 1.6 Unit tests: parent-child linkage on agent_spawn dispatch — rewritten from no-op to assertion. `services/process-hook-event.test.ts` covers (a) canonical `parent_session_id` payload, (b) back-compat `parent_agent` payload, (c) no-linkage payload short-circuits. `services/socket-server.test.ts` integration tests assert the dispatcher's agent_spawn case routes through `processHookEvent` to `SessionManager.updateLinkage` with both field shapes.
