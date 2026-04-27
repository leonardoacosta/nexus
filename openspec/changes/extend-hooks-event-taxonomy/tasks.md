# Implementation Tasks

<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-h8uxs -->

> Beads task ids appended by `beads:spec-sync --append`. The epic and feature
> beads above already exist (created by `/feature` for this proposal) — do NOT
> recreate.

## DB Batch

(none — this proposal is net-additive on `session_events.event_type` values; the existing schema in `packages/db/src/schema/sessionEvents.ts` already accepts arbitrary text. Schema design for a future `agent_invocations` table is explicitly out of scope.)

## API Batch

- [x] [2.1] [P-2] Extend `RECOGNIZED_EVENTS` Set in `apps/agent/src/routes/hooks.ts` to include all 21 new event types (lifecycle: `session_terminate`, `post_compact`, `pre_compact`, `heartbeat`; agents: `agent_spawn`, `agent_telemetry`, `agent_complete`; tools: `tool_use_end`, `tool_use_fail`; commands: `command_start`, `command_end`, `user_prompt`; operational: `permission_request`, `teammate_idle`, `task_completed`, `instructions_loaded`, `config_change`, `worktree_create`, `worktree_remove`, `notification`, `hook_failure`). Keep `session_heartbeat` in the set for backward compat. [owner:api-engineer] [type:code] [beads:nx-oyfi0]
- [x] [2.2] [P-2] Extend `HookEventPayload` interface in `apps/agent/src/routes/hooks.ts` with the optional fields each new event type carries. Cluster the additions by event family with TS-doc comments noting which events use each field: `tool` (tool_use_*, permission_request), `error` / `command` (tool_use_fail), `agent_type` / `agent_name` / `parent_agent` / `child_role` (agent_*), `run_id` / `parent_run_id` / `status` (command_*), `total_tokens` / `tool_uses` / `phase` / `wave` / `spec` (agent_telemetry), `handler` / `exit_code` / `stderr` (hook_failure), `compaction_count` (post_compact). [owner:api-engineer] [type:code] [beads:nx-1aouo]
- [x] [2.3] [P-2] Add a `case "session_terminate":` branch to the lifecycle `switch` in `apps/agent/src/routes/hooks.ts` `handleHooks`. Reuse the same finalization that `session_stop` / `stop_success` already trigger via `updateSessionStatus(db, sessionId, "ended")`. Idempotent on re-receipt. [owner:api-engineer] [type:code] [beads:nx-kngve]
- [x] [2.4] [P-3] All other new event types in this expansion fall through the existing default branch (no per-event handler), relying on the `appendSessionEvent` call earlier in `handleHooks` in `apps/agent/src/routes/hooks.ts` to write the row. Verify by reading the post-`restore-hooks-event-persistence` source: the append happens BEFORE the lifecycle switch, so default-case events are still persisted. [owner:api-engineer] [type:code] [beads:nx-vzwdp]
- [x] [2.5] [P-3] Update the response message format for newly-recognized events in `apps/agent/src/routes/hooks.ts` so they return `${eventName} acknowledged` (matching the existing recognized-event response) rather than `unknown event: ${eventName}`. The change is automatic once `RECOGNIZED_EVENTS` includes the new types — verify only. [owner:api-engineer] [type:code] [beads:nx-ki4a1]

## UI Batch

(none — pure backend persistence. Dashboard surfacing of new event types is owned by `add-hooks-sse-fanout`.)

## E2E Batch

- [x] [3.1] [P-2] Add Lifecycle handler tests in `apps/agent/src/routes/hooks.test.ts` for `session_terminate` (assert sessions.status becomes `ended` and `endedAt` is set), `post_compact` (assert `session_events` row + `metadata.compaction_count` preserved), `pre_compact`, and `heartbeat` (assert `session_events` row written despite name divergence from legacy `session_heartbeat`). [owner:test-writer] [type:testing] [beads:nx-3roin]
- [x] [3.2] [P-2] Add Agent-Lifecycle handler tests in `apps/agent/src/routes/hooks.test.ts` for `agent_spawn` (assert `metadata` preserves `agent_type`, `agent_name`, `parent_agent`, `child_role`, `model`), `agent_complete` (assert row written), and `agent_telemetry` (assert `metadata` preserves `total_tokens`, `tool_uses`, `duration_ms`, `phase`, `wave`, `spec`). [owner:test-writer] [type:testing] [beads:nx-oqxey]
- [x] [3.3] [P-2] Add Tool-Use handler tests in `apps/agent/src/routes/hooks.test.ts` for `tool_use_end` (assert `metadata.tool` preserved) and `tool_use_fail` (assert `metadata.error`, `metadata.command`, `metadata.duration_ms` preserved verbatim). [owner:test-writer] [type:testing] [beads:nx-7tuhh]
- [x] [3.4] [P-2] Add Command handler tests in `apps/agent/src/routes/hooks.test.ts` for `command_start` (assert `metadata.run_id` preserved for join), `command_end` (assert `metadata.status` and `metadata.duration_ms` preserved), and `user_prompt` (assert row written with `event_type='user_prompt'`). [owner:test-writer] [type:testing] [beads:nx-6ce8e]
- [x] [3.5] [P-2] Add Operational handler tests in `apps/agent/src/routes/hooks.test.ts` for `permission_request`, `teammate_idle`, `task_completed`, `instructions_loaded`, `config_change`, `worktree_create`, `worktree_remove`, `notification`, and `hook_failure` (assert each writes one `session_events` row with the right `event_type` and that the parent `sessions` row is NOT mutated). [owner:test-writer] [type:testing] [beads:nx-axicb]
- [x] [3.6] [P-2] Add a backward-compat handler test in `apps/agent/src/routes/hooks.test.ts` proving an unrecognized future event type (`future_event_type_not_yet_invented`) still returns HTTP 200 with the legacy `unknown event: …` message AND writes no `session_events` row. [owner:test-writer] [type:testing] [beads:nx-n1tt6]
- [ ] [3.7] [P-3] [user] After deploy, send live `session_terminate` and `tool_use_fail` payloads via the deployed dev agent and confirm rows appear in `session_events` within 1s. Reuses the smoke-test pattern from `restore-hooks-event-persistence` task 3.2 (`apps/agent/src/routes/hooks.test.ts` integration). [owner:user] [type:testing] [beads:nx-uk56r]
- [ ] [3.8] [P-3] [user] Telemetry-side cleanup: after this lands and stabilizes, file a follow-up to update `~/.claude/scripts/hooks/telemetry.sh:697` `handle_heartbeat` so it emits `event_type='session_heartbeat'` (canonical) instead of `heartbeat` (current). Until then, the agent accepts both. [owner:user] [type:cleanup] [beads:nx-75842]
