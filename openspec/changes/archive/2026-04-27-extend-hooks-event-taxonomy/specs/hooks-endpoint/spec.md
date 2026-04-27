# hooks-endpoint Specification (delta)

## ADDED Requirements

### Requirement: Lifecycle Event Persistence

nexus-agent SHALL recognize and persist the lifecycle events `session_terminate`, `post_compact`, `pre_compact`, and `heartbeat`. Each event SHALL produce one row in `session_events` with the full payload JSON-stringified into `metadata`. `session_terminate` SHALL additionally finalize the parent session row by setting `ended_at = NOW()` and `status = 'ended'` (idempotent on re-receipt).

#### Scenario: session_terminate finalizes a still-active session
- **GIVEN** session `sess-term-1` has `status='active'` and `ended_at=NULL`
- **WHEN** a payload `{hook_event_name: "session_terminate", session_id: "sess-term-1"}` arrives
- **THEN** `session_events` receives a row with `event_type='session_terminate'`
- **AND** the `sessions` row is updated to `status='ended'`, `ended_at=NOW()`
- **AND** the response is HTTP 200

#### Scenario: post_compact persists with compaction context in metadata
- **GIVEN** session `sess-compact-1` is active
- **WHEN** a payload `{hook_event_name: "post_compact", session_id: "sess-compact-1", compaction_count: 3}` arrives
- **THEN** `session_events` receives a row with `event_type='post_compact'` and `metadata` containing the JSON payload
- **AND** subsequent `post_compact` events for the same session keep appending rows (one row per event)

#### Scenario: heartbeat persists despite name divergence
- **GIVEN** cc emits `event_type='heartbeat'` (singular, per `~/.claude/scripts/hooks/telemetry.sh:697`) — NOT `session_heartbeat`
- **WHEN** the heartbeat payload arrives at `/hooks`
- **THEN** `session_events` receives a row with `event_type='heartbeat'`
- **AND** the agent-side whitelist accepts both `heartbeat` and the legacy `session_heartbeat` for backward compatibility

### Requirement: Agent-Lifecycle Event Persistence

nexus-agent SHALL recognize and persist the agent-lifecycle events `agent_spawn`, `agent_telemetry`, and `agent_complete`. Payload-typed fields (`agent_type`, `agent_name`, `parent_agent`, `child_role`, `model`, `total_tokens`, `tool_uses`, `duration_ms`, `spec`, `wave`, `phase`, `status`) SHALL be preserved verbatim in the `metadata` JSON column. No new table is created in this spec — a dedicated `agent_invocations` table is explicitly deferred to a follow-up.

#### Scenario: agent_spawn persists with full audit fields
- **GIVEN** a payload `{hook_event_name: "agent_spawn", session_id: "sess-1", agent_type: "ui-engineer", agent_name: "ui-engineer-abc", parent_agent: "orchestrator", child_role: "engineer", model: "claude-sonnet-4-5"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='agent_spawn'` and `metadata` containing all six payload fields
- **AND** the response is HTTP 200

#### Scenario: agent_complete persists deregistration
- **GIVEN** a payload `{hook_event_name: "agent_complete", session_id: "sess-1", agent_type: "ui-engineer"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='agent_complete'`

#### Scenario: agent_telemetry persists token + duration metrics
- **GIVEN** a payload `{hook_event_name: "agent_telemetry", session_id: "sess-1", agent_name: "ui-engineer-abc", spec: "extend-hooks-event-taxonomy", wave: "2", phase: "apply", model: "claude-sonnet-4-5", total_tokens: 12450, tool_uses: 8, duration_ms: 23000, status: "success"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='agent_telemetry'` and `metadata` containing all telemetry fields

### Requirement: Tool-Use Event Persistence

nexus-agent SHALL recognize and persist `tool_use_end` and `tool_use_fail`. Both SHALL preserve the full payload as `metadata` JSON. `tool_use_fail` payloads SHALL preserve the `tool`, `error`, `command`, and `duration_ms` fields exactly as emitted.

#### Scenario: tool_use_end persists with tool name and duration
- **GIVEN** a payload `{hook_event_name: "tool_use_end", session_id: "sess-1", tool: "Edit", success: true, duration_ms: 1200}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='tool_use_end'` and `metadata.tool='Edit'`

#### Scenario: tool_use_fail persists error snippet without truncation in storage
- **GIVEN** a payload `{hook_event_name: "tool_use_fail", session_id: "sess-1", tool: "Bash", error: "permission denied", command: "git push", duration_ms: 80}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='tool_use_fail'`
- **AND** `metadata` contains the original `error`, `command`, and `tool` strings (the agent does not re-truncate; whatever telemetry.sh sent is what gets stored)

### Requirement: Command Event Persistence

nexus-agent SHALL recognize and persist `command_start`, `command_end`, and `user_prompt`. Each row SHALL preserve correlation identifiers (`run_id`, `parent_run_id`, `command`) where present. `user_prompt` payloads MAY contain prompt text in `metadata`; storage is verbatim — no redaction in this spec.

#### Scenario: command_start persists run_id for correlation
- **GIVEN** a payload `{hook_event_name: "command_start", session_id: "sess-1", run_id: "run-abc", command: "/apply:all", project: "nx"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='command_start'`
- **AND** `metadata.run_id='run-abc'` so a downstream consumer can join command_start with command_end

#### Scenario: command_end persists status and duration
- **GIVEN** a payload `{hook_event_name: "command_end", session_id: "sess-1", run_id: "run-abc", command: "/apply:all", status: "success", duration_ms: 540000, agent_count: 3, total_tokens: 87654}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='command_end'` and `metadata.status='success'`

#### Scenario: user_prompt persists text verbatim
- **GIVEN** a payload `{hook_event_name: "user_prompt", session_id: "sess-1", project: "nx"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='user_prompt'`

### Requirement: Operational Event Persistence

nexus-agent SHALL recognize and persist the operational events `permission_request`, `teammate_idle`, `task_completed`, `instructions_loaded`, `config_change`, `worktree_create`, `worktree_remove`, `notification`, and `hook_failure`. Each is treated uniformly: append one `session_events` row with the full payload as `metadata`. No `sessions`-table side effect.

#### Scenario: permission_request persists tool name in metadata
- **GIVEN** a payload `{hook_event_name: "permission_request", session_id: "sess-1", tool: "Bash"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='permission_request'` and `metadata.tool='Bash'`

#### Scenario: hook_failure persists handler diagnostics
- **GIVEN** a payload `{hook_event_name: "hook_failure", session_id: "sess-1", handler: "handle_session_stop", event: "session_stop", exit_code: 1, stderr: "stats jq write failed"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='hook_failure'`
- **AND** `metadata.handler='handle_session_stop'` so observability dashboards can surface telemetry self-failure rates

#### Scenario: worktree_create persists without sessions-table mutation
- **GIVEN** a payload `{hook_event_name: "worktree_create", session_id: "sess-1", project: "nx"}`
- **WHEN** the handler processes the request
- **THEN** `session_events` receives a row with `event_type='worktree_create'`
- **AND** the parent `sessions` row is NOT mutated (status, ended_at unchanged)

### Requirement: Backward Compatibility for Acknowledge-Only Events

nexus-agent SHALL continue to return HTTP 200 for any payload whose `hook_event_name` is unrecognized after this expansion. Unknown events SHALL log a warn-level line including the unrecognized event name but SHALL NOT produce a `session_events` row. This preserves the post-`restore-hooks-event-persistence` contract that fire-and-forget hook delivery never blocks cc.

#### Scenario: Truly unknown event type still returns 200 with log line
- **GIVEN** a payload `{hook_event_name: "future_event_type_not_yet_invented", session_id: "sess-1"}`
- **WHEN** the handler processes the request
- **THEN** the response is HTTP 200 with `{status: "ok", message: "unknown event: future_event_type_not_yet_invented"}`
- **AND** no `session_events` row is written
- **AND** a warn-level log line is emitted including the event name
