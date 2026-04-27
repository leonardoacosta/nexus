# hooks-endpoint Specification

## Purpose
TBD - created by archiving change add-http-hooks-receiver. Update Purpose after archive.
## Requirements
### Requirement: POST /hooks Endpoint

nexus-agent SHALL expose a `POST /hooks` endpoint that accepts JSON payloads from Claude Code HTTP hooks and telemetry.sh, **persists each event to the `events` table**, dispatches based on `hook_event_name` or `event` field, and updates the `sessions` table for lifecycle events.

The endpoint MUST NOT regress to a "log-and-acknowledge" no-op pattern. Every recognized event type MUST produce at least one database write before returning 200 OK.

#### Scenario: Event row written for every recognized event
- **GIVEN** a payload with `hook_event_name: "session_start"`, `session_id: "abc-123"`, `project: "oo"`
- **WHEN** the handler processes the request
- **THEN** a row is inserted into the `events` table with `event_type='session_start'`, `session_id='abc-123'`, `project='oo'`, `timestamp=NOW()`
- **AND** the response is HTTP 200 with `{"status": "ok"}`

#### Scenario: Diagnostic ping is persisted
- **GIVEN** a payload with `hook_event_name: "diagnostic_ping"`, `session_id: "diag-test"`
- **WHEN** the handler processes the request
- **THEN** a row appears in the `events` table within 100ms
- **AND** `SELECT * FROM events WHERE event_type='diagnostic_ping'` returns at least one row

### Requirement: SessionSummary Event Type

nexus-agent SHALL support `session_summary` events that carry per-session monitoring data including tool usage counts, failure count, compaction count, agent spawn count, duration, model, **input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, and cost_usd**. Token and cost fields MAY be omitted by older callers; when present, they SHALL be persisted into the `sessions` table.

#### Scenario: Summary with cost data updates sessions table
- **GIVEN** session "abc-123" has an active row in the `sessions` table
- **AND** a payload with `event: "session_summary"`, `session_id: "abc-123"`, `output_tokens: 224148`, `cache_read_input_tokens: 14977166`, `cost_usd: 88.45`
- **WHEN** the handler processes the request
- **THEN** the sessions row's `total_cost_usd` becomes `88.45`
- **AND** if a `session_token_aggregates` table exists, per-turn rows are inserted

#### Scenario: Summary without explicit cost computes from tokens
- **GIVEN** a payload with `event: "session_summary"`, token fields populated, `model: "claude-opus-4-7"`, but NO `cost_usd` field
- **WHEN** the handler processes the request
- **THEN** the handler computes cost server-side using model-aware rates (Opus 4.7: $15/M input, $75/M output, $1.50/M cache_read, $30/M cache_write 1h)
- **AND** the computed value is stored in `total_cost_usd`

### Requirement: SessionStop Event Type

nexus-agent SHALL support `session_stop` events that finalize an active session. On receipt, `ended_at` SHALL be set to NOW() and `status` SHALL transition to `"ended"`.

#### Scenario: session_stop finalizes the session row
- **GIVEN** session "abc-123" has `status='active'` and `ended_at=NULL`
- **WHEN** a `session_stop` event arrives for `session_id: "abc-123"`
- **THEN** the sessions row is updated: `ended_at=NOW()`, `status='ended'`
- **AND** the events table also receives a row for the stop event

### Requirement: StopFailure Event Type

nexus-agent SHALL support `stop_failure` events that record session-level errors. On receipt, `status` SHALL transition to `"errored"` and the `stop_reason` field SHALL be persisted in the events row's data column.

#### Scenario: stop_failure marks session errored
- **GIVEN** session "abc-123" is active
- **WHEN** a `stop_failure` event arrives with `stop_reason: "api_error"`
- **THEN** the sessions row is updated: `status='errored'`, `ended_at=NOW()`
- **AND** the events row stores `stop_reason='api_error'` in its data column

### Requirement: Diagnostic Ping for Operability Verification

nexus-agent SHALL accept a `diagnostic_ping` event type whose sole purpose is round-trip persistence verification. Operators SHALL be able to send this event and confirm the write path is healthy.

#### Scenario: Diagnostic ping enables liveness check
- **GIVEN** an operator wants to verify nexus-agent persistence
- **WHEN** they POST `{"hook_event_name": "diagnostic_ping", "session_id": "diag-<timestamp>"}` to `/hooks`
- **THEN** within 1 second, `SELECT * FROM events WHERE event_type='diagnostic_ping' AND session_id='diag-<timestamp>'` returns the row
- **AND** the operator can use this as a smoke test in deployment scripts

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

### Requirement: Hook events emit to lifecycleBus after persistence

nexus-agent SHALL emit a `HookEventReceived` lifecycle event after each successful `appendSessionEvent` insert in `handleHooks`. The event MUST be emitted on `lifecycleBus` (the singleton in `apps/agent/src/services/lifecycle-bus.ts`) with payload shape `{ eventType: string, sessionId: string, project?: string, eventId: number }`.

The emit MUST happen ONLY when persistence succeeded — i.e. `insertedEventId !== null`. If `appendSessionEvent` throws, the existing fire-and-forget swallow path applies and NO `HookEventReceived` event MAY be emitted (avoid broadcasting an event id that resolves to no row).

The emit MUST NOT block the HTTP response: `lifecycleBus.emit` is synchronous and in-process, but any future async subscribers MUST NOT be awaited.

#### Scenario: Persistence success emits HookEventReceived
- **GIVEN** a payload with `hook_event_name: "session_start"`, `session_id: "abc-123"`, `project: "oo"`
- **WHEN** the handler processes the request
- **AND** `appendSessionEvent` returns event id `42`
- **THEN** `lifecycleBus.emit("HookEventReceived", { eventType: "session_start", sessionId: "abc-123", project: "oo", eventId: 42 })` is called exactly once
- **AND** the HTTP response is HTTP 200 with `{"status": "ok", "event_id": 42}`

#### Scenario: Persistence failure suppresses emit
- **GIVEN** a payload that triggers a DB error inside `appendSessionEvent`
- **WHEN** the handler catches the error and logs it
- **THEN** NO `HookEventReceived` event is emitted on `lifecycleBus`
- **AND** the HTTP response is HTTP 200 with `"persistence error logged"` (existing fire-and-forget behavior preserved)

#### Scenario: Project field is optional
- **GIVEN** a payload missing the `project` field
- **WHEN** the handler persists the event successfully
- **THEN** the emitted `HookEventReceived` payload omits `project` (or sets it to `undefined`)
- **AND** the event still flows to subscribers

### Requirement: SSE stream broadcasts hook events to subscribers

The `GET /events/stream` endpoint SHALL deliver every `HookEventReceived` envelope to every connected subscriber via the existing `lifecycleBus.onAny` wiring in `apps/agent/src/routes/events-sse.ts`. The agent MUST NOT filter events server-side based on subscriber identity, query params, or session scope — filtering is the subscriber's responsibility.

The SSE frame format follows the existing convention used by other lifecycle events:
```
event: HookEventReceived
data: { "event": "HookEventReceived", "payload": { ... }, "source": "local", "seq": N, "ts": "...", "origin": "..." }
```

#### Scenario: Subscriber receives HookEventReceived envelope
- **GIVEN** a client connected to `GET /events/stream`
- **AND** the agent receives a `session_start` hook event that persists successfully
- **WHEN** `lifecycleBus.emit("HookEventReceived", ...)` fires
- **THEN** the client receives an SSE frame with `event: HookEventReceived`
- **AND** the `data:` line parses to a `LifecycleEnvelope` with `event === "HookEventReceived"` and the lean payload

#### Scenario: Server does not filter by subscriber
- **GIVEN** two SSE subscribers — one interested in `session_*` events, one interested in `tool_use_*` events
- **WHEN** any hook event is persisted
- **THEN** both subscribers receive the same `HookEventReceived` envelope
- **AND** each subscriber filters by `payload.eventType` client-side

### Requirement: High-volume hook events are throttled

nexus-agent SHALL coalesce high-frequency `HookEventReceived` emits over a 500ms window per `(eventType, sessionId)` key. Throttled event types include at minimum `tool_use_start` and `tool_use_end`. Other event types (lifecycle, summaries, diagnostics) emit immediately.

Coalesced emits carry `count` (number of suppressed events in the window, ≥1) and the `eventId` of the **last** suppressed event. When `count === 1`, the emit is observationally identical to an immediate emit. When `count > 1`, subscribers know the eventId points to the most recent of N events and can fetch a range if needed.

The throttle window MUST be configurable via an exported constant for tests; production default is 500ms.

#### Scenario: Burst of tool_use_end coalesces to one event per window
- **GIVEN** 20 `tool_use_end` events arrive for `session_id: "abc-123"` within a 200ms span
- **WHEN** the throttle window is 500ms
- **THEN** subscribers receive exactly 1 `HookEventReceived` for that session at the end of the window
- **AND** the payload carries `count: 20` and `eventId` equal to the row id of the 20th event

#### Scenario: Lifecycle events bypass throttle
- **GIVEN** a `session_start` event arrives
- **WHEN** the handler emits `HookEventReceived`
- **THEN** the event reaches subscribers immediately (no 500ms delay)
- **AND** the payload omits `count` (or sets `count: 1`)

#### Scenario: Throttle keys isolate by session
- **GIVEN** `tool_use_end` events for `session_id: "A"` and `session_id: "B"` arrive within the same window
- **WHEN** the throttle coalesces
- **THEN** subscribers receive 2 `HookEventReceived` events — one per session — not a single merged event

### Requirement: Subscriber filtering is client-side

Dashboard pages SHALL implement event-type filtering in the browser. The Next.js SSE proxy at `apps/nextjs/src/app/api/notifications/stream/route.ts` (or a sibling `/api/hooks/stream` if added) MUST forward all envelopes; per-page subscribers MUST inspect `payload.eventType` and `payload.sessionId` / `payload.project` to decide whether to refetch.

This requirement codifies the architecture decision: server stateless re: subscriber interest. New dashboard surfaces add no agent-side code.

#### Scenario: Session detail page filters by sessionId
- **GIVEN** the user is viewing `/session/abc-123`
- **AND** the page subscribes to `HookEventReceived`
- **WHEN** an event arrives with `payload.sessionId === "other-session"`
- **THEN** the page ignores it (no refetch)
- **WHEN** an event arrives with `payload.sessionId === "abc-123"`
- **THEN** the page refetches `/sessions/abc-123` (or the session-events query) and re-renders

#### Scenario: Project page filters by project
- **GIVEN** the user is viewing `/projects/oo`
- **WHEN** an event arrives with `payload.project === "tl"`
- **THEN** the page ignores it
- **WHEN** an event arrives with `payload.project === "oo"`
- **THEN** the page refetches the project's session list and updates the badge counts

### Requirement: Selected hook events trigger notifications

After persisting an event row in the `session_events` table, `handleHooks` SHALL evaluate the event payload against a curated set of notification rules. Each rule maps an event type (and optional predicate over payload fields) to a notification draft consisting of `{ title, body, channels }`. Matching rules SHALL produce notifications via the existing `NotificationManager.send()` path so they flow through the same buffer / meeting-state / parallel-delivery pipeline as `/notifications/send`.

The v1 rule set MUST include exactly the following five triggers (mirroring the cc-side curated routing policy in `~/.claude/scripts/hooks/telemetry.sh`):

| Event type | Predicate | Channels |
|---|---|---|
| `tool_use_fail` | always | `desktop`, `slack` |
| `permission_request` | always | `desktop`, `tts` |
| `hook_failure` | always | `desktop`, `slack` |
| `session_stop` | payload `crash_flag === true` (or equivalent stop_reason indicating a crash) | `desktop`, `slack` |
| `session_summary` | payload `cost_usd >= 0.50` | `desktop` |

Notification body SHALL be project-prefixed (`"<project>: <message>"`) when the payload carries a `project` field, matching the convention used elsewhere in the notification pipeline.

#### Scenario: tool_use_fail fires desktop + slack

- **GIVEN** a `tool_use_fail` payload with `session_id="abc-123"`, `project="oo"`, `tool_name="Bash"`, `error_message="permission denied"`
- **WHEN** `handleHooks` processes the request
- **THEN** the event row is persisted in `session_events` first
- **AND** a notification is sent with `channels=["desktop","slack"]`
- **AND** the notification body contains the tool name and error
- **AND** the response is HTTP 200

#### Scenario: permission_request fires desktop + tts

- **GIVEN** a `permission_request` payload with `session_id="abc-123"`, `project="oo"`, `tool_name="Edit"`
- **WHEN** `handleHooks` processes the request
- **THEN** a notification is sent with `channels=["desktop","tts"]`
- **AND** the TTS body contains the project prefix and a human-readable description of the prompt
- **AND** the response is HTTP 200

#### Scenario: hook_failure fires desktop + slack

- **GIVEN** a `hook_failure` payload with `hook_name="post_compact"`, `error_message="jq write failed"`
- **WHEN** `handleHooks` processes the request
- **THEN** a notification is sent with `channels=["desktop","slack"]`

#### Scenario: session_stop with crash flag fires desktop + slack

- **GIVEN** a `session_stop` payload with `session_id="abc-123"`, `crash_flag=true`
- **WHEN** `handleHooks` processes the request
- **THEN** the lifecycle side effect (status='ended', ended_at=NOW()) runs as before
- **AND** a notification is sent with `channels=["desktop","slack"]`

#### Scenario: session_stop without crash flag does NOT trigger notification

- **GIVEN** a `session_stop` payload with `session_id="abc-123"` and NO `crash_flag` (or `crash_flag=false`)
- **WHEN** `handleHooks` processes the request
- **THEN** the lifecycle side effect runs as before
- **AND** NO notification is dispatched

#### Scenario: session_summary above cost threshold fires desktop digest

- **GIVEN** a `session_summary` payload with `session_id="abc-123"`, `cost_usd=2.34`
- **WHEN** `handleHooks` processes the request
- **THEN** the sessions row's `total_cost_usd` is updated as before
- **AND** a notification is sent with `channels=["desktop"]`
- **AND** the body is a digest containing the cost figure

#### Scenario: session_summary below cost threshold does NOT trigger notification

- **GIVEN** a `session_summary` payload with `cost_usd=0.12`
- **WHEN** `handleHooks` processes the request
- **THEN** the sessions row update runs as before
- **AND** NO notification is dispatched

#### Scenario: unmatched event types produce no notification

- **GIVEN** a `session_heartbeat`, `diagnostic_ping`, `session_start`, `stop_success`, or `agent_spawn` payload
- **WHEN** `handleHooks` processes the request
- **THEN** the event is persisted normally
- **AND** NO notification is dispatched

### Requirement: Suppression dedupes within configured windows

To prevent notification storms in tight retry loops or repeated permission prompts, each rule SHALL define a suppression window. The notification trigger SHALL maintain an in-process cache keyed by a per-rule suppression key; a key seen within its window SHALL skip notification dispatch (the event row is still written — suppression applies only to the notification layer).

| Event type | Suppression key | Window |
|---|---|---|
| `tool_use_fail` | `tool_use_fail:<tool_name>` | 30 seconds |
| `permission_request` | none (always fire) | n/a |
| `hook_failure` | `hook_failure:<hook_name>` | 30 seconds |
| `session_stop` (crash) | `session_stop:<session_id>` | per session (effectively infinite) |
| `session_summary` (digest) | `session_summary:<session_id>` | per session (effectively infinite) |

#### Scenario: tool_use_fail dedupes within 30 seconds

- **GIVEN** a `tool_use_fail` payload with `tool_name="Bash"` is processed
- **AND** another `tool_use_fail` payload with `tool_name="Bash"` arrives 5 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** the second event is persisted in `session_events`
- **AND** NO notification is dispatched for the second event
- **AND** the suppression cache reflects the most recent timestamp

#### Scenario: tool_use_fail with different tool_name is not suppressed

- **GIVEN** a `tool_use_fail` payload with `tool_name="Bash"` is processed
- **AND** a `tool_use_fail` payload with `tool_name="Edit"` arrives 5 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** BOTH events fire notifications

#### Scenario: tool_use_fail after window expires fires again

- **GIVEN** a `tool_use_fail` payload with `tool_name="Bash"` is processed
- **AND** another `tool_use_fail` payload with `tool_name="Bash"` arrives 35 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** BOTH events fire notifications

#### Scenario: permission_request never deduplicates

- **GIVEN** three consecutive `permission_request` payloads arrive within 5 seconds
- **WHEN** `handleHooks` processes them
- **THEN** ALL three fire desktop + tts notifications

#### Scenario: session_stop crash dedupes per session

- **GIVEN** a `session_stop` payload with `session_id="abc-123"` and `crash_flag=true` fires a notification
- **AND** an erroneous duplicate `session_stop` for `session_id="abc-123"` arrives 60 seconds later
- **WHEN** `handleHooks` processes the duplicate
- **THEN** NO additional notification is dispatched

### Requirement: notification_settings is honored at dispatch time

Before sending a triggered notification, the rule engine SHALL read the current `notification_settings` row (id=1) and filter the rule's `channels` array against user toggles:

- When `tts_enabled === false`, the `"tts"` channel SHALL be removed from the dispatch set.
- When `banner_enabled === false`, the `"desktop"` channel SHALL be removed from the dispatch set.
- The `"slack"` channel is not gated by per-channel settings in v1.
- When the filtered channel set is empty, the trigger SHALL skip the `NotificationManager.send()` call entirely (no zero-channel notification row).
- `ducking_mode` is NOT consulted by the trigger; volume is a render-layer concern and remains the Mac listener's responsibility.

#### Scenario: tts_enabled=false skips TTS for permission_request

- **GIVEN** `notification_settings` has `tts_enabled=false, banner_enabled=true`
- **AND** a `permission_request` payload arrives
- **WHEN** the trigger evaluates
- **THEN** the dispatched channels are `["desktop"]` only
- **AND** no TTS synthesis or `NotificationFired` event for the TTS channel occurs

#### Scenario: banner_enabled=false skips desktop for tool_use_fail

- **GIVEN** `notification_settings` has `tts_enabled=true, banner_enabled=false`
- **AND** a `tool_use_fail` payload arrives
- **WHEN** the trigger evaluates
- **THEN** the dispatched channels are `["slack"]` only

#### Scenario: both desktop and TTS disabled with no slack collapses to no-op

- **GIVEN** `notification_settings` has `tts_enabled=false, banner_enabled=false`
- **AND** a `permission_request` payload arrives (rule channels: `["desktop","tts"]`, no Slack)
- **WHEN** the trigger evaluates
- **THEN** NO `NotificationManager.send()` call occurs
- **AND** NO row is inserted into the `notifications` table for this trigger

#### Scenario: settings missing falls back to all-enabled defaults

- **GIVEN** the `notification_settings` row is unexpectedly absent
- **WHEN** a trigger evaluates
- **THEN** the trigger SHALL behave as if all toggles are enabled (failsafe: surface the notification rather than swallow it)

### Requirement: Rules are declarative and individually testable

Each notification rule SHALL be expressed as a pure function — given a hook event payload, it returns either a `NotificationDraft` (`{ title, body, channels }`) or `null` (no match). Rules SHALL NOT reach into the database, the lifecycle bus, or external clients during evaluation. Side effects (suppression cache reads/writes, `notification_settings` lookups, `NotificationManager.send()`) live in a single trigger orchestrator, not in the rule bodies.

This enables per-rule unit tests: build a fixture payload, call the rule, assert the returned draft (or null). Suppression behavior, settings filtering, and the integration with `handleHooks` are tested separately at the orchestrator and route levels.

#### Scenario: Each rule is unit-testable in isolation

- **GIVEN** a fixture `tool_use_fail` payload with the minimum required fields
- **WHEN** the `tool_use_fail` rule's predicate-and-toNotification function is called directly
- **THEN** the function returns a `NotificationDraft` with `channels=["desktop","slack"]`
- **AND** the function does not require a database, lifecycle bus, or HTTP client

#### Scenario: Rule predicate filters at the function boundary

- **GIVEN** a `session_summary` payload with `cost_usd=0.10`
- **WHEN** the `session_summary` rule is called directly
- **THEN** the function returns `null` (predicate failed; no draft produced)

#### Scenario: Rule registry exposes all five rules for inspection

- **WHEN** the trigger module's exported rule registry is iterated
- **THEN** exactly five rules are present
- **AND** their `eventType` fields are: `tool_use_fail`, `permission_request`, `hook_failure`, `session_stop`, `session_summary`

