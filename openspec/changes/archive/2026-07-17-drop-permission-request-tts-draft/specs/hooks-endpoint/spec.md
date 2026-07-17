# hooks-endpoint — delta for drop-permission-request-tts-draft

## MODIFIED Requirements

### Requirement: Selected hook events trigger notifications

After persisting an event row in the `session_events` table, `handleHooks` SHALL evaluate the event payload against a curated set of notification rules. Each rule maps an event type (and optional predicate over payload fields) to a notification draft consisting of `{ title, body, channels }`. Matching rules SHALL produce notifications via the existing `NotificationManager.send()` path so they flow through the same buffer / meeting-state / parallel-delivery pipeline as `/notifications/send`.

The v1 rule set MUST include exactly the following three triggers (mirroring the cc-side curated routing policy in `~/.claude/scripts/hooks/telemetry.sh`):

| Event type | Predicate | Channels |
|---|---|---|
| `hook_failure` | always | `desktop`, `slack` |
| `session_stop` | payload `crash_flag === true` (or equivalent stop_reason indicating a crash) | `desktop`, `slack` |
| `session_summary` | payload `cost_usd >= 0.50` | `desktop` |

Notification body SHALL be project-prefixed (`"<project>: <message>"`) when the payload carries a `project` field, matching the convention used elsewhere in the notification pipeline.

> **2026-07-15 correction (nx-l08rs)**: `tool_use_fail` was REMOVED from this
> trigger set. It fired a desktop banner on every failed tool call across
> every client, throttled only by a 30-second per-tool-name suppression
> window — never eliminated (112 real banners in 48 hours). `tool_use_fail`
> events are still recognized and persisted to `session_events` (see
> "Tool-Use Event Persistence" above); only the notification mapping was
> removed. This capability spec predates `add-api-error-notification`
> (which added the `api_error` trigger) and `remove-slack-channel` (which
> removed the `slack` channel referenced below) — those are pre-existing
> drift, out of scope for this correction.

> **2026-07-16 correction (drop-permission-request-tts-draft, amended same
> night)**: the `permission_request` rule was dual-channel (`desktop`, `tts`)
> — the only two-draft rule in the registry — and each draft was minted with
> its own id, so the push layer's dedup-by-id alerted every device once per
> draft (verified: rows `fd6d30cd`/`7c9ef315`, 1ms apart, both "sent 3/3
> devices"). Both drafts were also contentless ("permission requested for
> <tool>") while cc telemetry.sh's rich `nx_notify` body — which enumerates
> the actual questions and answer choices — arrived beside them as a third
> push. The rule is therefore REMOVED entirely: the rich `nx_notify` POST via
> `/notifications/send` is the sole notification surface for permission
> events. `permission_request` events are still recognized and persisted
> (telemetry path unchanged); only the notification mapping is gone. To keep
> the rich banner's title/deep-link parity, `/notifications/send` accepts
> optional `session_name`/`session_id` body fields threaded to the push layer.

#### Scenario: permission_request produces no rule-based notification

- **GIVEN** a `permission_request` payload with `session_id="abc-123"`, `project="oo"`, `tool_name="AskUserQuestion"`
- **WHEN** `handleHooks` processes the request
- **THEN** the event is persisted normally
- **AND** NO notification is dispatched by the rule registry (any channel)
- **AND** the response is HTTP 200

#### Scenario: notifications send threads session identity to the push

- **GIVEN** a `POST /notifications/send` payload with `project="nx"`, `session_name="fix-login"`, `session_id="abc-123"`, and a body enumerating the permission questions
- **WHEN** the route processes the request
- **THEN** `manager.send()` receives `sessionName="fix-login"` and `sessionId="abc-123"` extras
- **AND** the resulting alert push is titled `nx · fix-login` (composeTitle) and carries `userInfo.sessionId="abc-123"`

#### Scenario: composed title does not duplicate the project prefix

- **GIVEN** a notification with `project="cc"` and `session_name="cc · main"` (CC session names are conventionally `<code> · <branch>`-shaped)
- **WHEN** the alert-push title is composed
- **THEN** the title is `cc · main` — composeTitle SHALL skip the project segment when the session name already starts with `<project> · ` or equals the project

#### Scenario: notifications send without session fields degrades gracefully

- **GIVEN** a `POST /notifications/send` payload with no `session_name`/`session_id`
- **WHEN** the route processes the request
- **THEN** the notification is delivered exactly as before this change (no session extras, title falls back to project/fallback ladder)

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
