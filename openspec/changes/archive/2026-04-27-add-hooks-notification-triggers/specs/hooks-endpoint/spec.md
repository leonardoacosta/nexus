# hooks-endpoint Specification (delta)

## ADDED Requirements

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
