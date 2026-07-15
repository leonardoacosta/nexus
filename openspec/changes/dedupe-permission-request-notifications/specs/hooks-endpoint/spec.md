## MODIFIED Requirements

### Requirement: Suppression dedupes within configured windows

To prevent notification storms in tight retry loops or repeated permission prompts, each rule SHALL define a suppression window. The notification trigger SHALL maintain an in-process cache keyed by a per-rule suppression key; a key seen within its window SHALL skip notification dispatch (the event row is still written — suppression applies only to the notification layer).

| Event type | Suppression key | Window |
|---|---|---|
| `permission_request` | `permission_request:<session_id>` | 2 seconds |
| `hook_failure` | `hook_failure:<hook_name>` | 30 seconds |
| `session_stop` (crash) | `session_stop:<session_id>` | per session (effectively infinite) |
| `session_summary` (digest) | `session_summary:<session_id>` | per session (effectively infinite) |

#### Scenario: hook_failure dedupes within 30 seconds

- **GIVEN** a `hook_failure` payload with `hook_name="post_compact"` is processed
- **AND** another `hook_failure` payload with `hook_name="post_compact"` arrives 5 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** the second event is persisted in `session_events`
- **AND** NO notification is dispatched for the second event
- **AND** the suppression cache reflects the most recent timestamp

#### Scenario: hook_failure with different hook_name is not suppressed

- **GIVEN** a `hook_failure` payload with `hook_name="post_compact"` is processed
- **AND** a `hook_failure` payload with `hook_name="session_stop"` arrives 5 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** BOTH events fire notifications

#### Scenario: hook_failure after window expires fires again

- **GIVEN** a `hook_failure` payload with `hook_name="post_compact"` is processed
- **AND** another `hook_failure` payload with `hook_name="post_compact"` arrives 35 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** BOTH events fire notifications

#### Scenario: permission_request dedupes within 2 seconds for the same session

- **GIVEN** a `permission_request` payload with `session_id="abc-123"` is processed
- **AND** another `permission_request` payload with `session_id="abc-123"` arrives 150ms later
- **WHEN** `handleHooks` processes the second request
- **THEN** the second event is persisted in `session_events`
- **AND** NO notification is dispatched for the second event

#### Scenario: permission_request with a different session_id is not suppressed

- **GIVEN** a `permission_request` payload with `session_id="abc-123"` is processed
- **AND** a `permission_request` payload with `session_id="xyz-789"` arrives 150ms later
- **WHEN** `handleHooks` processes the second request
- **THEN** BOTH events fire notifications

#### Scenario: permission_request after its 2-second window expires fires again

- **GIVEN** a `permission_request` payload with `session_id="abc-123"` is processed
- **AND** another `permission_request` payload with `session_id="abc-123"` arrives 3 seconds later
- **WHEN** `handleHooks` processes the second request
- **THEN** BOTH events fire notifications

#### Scenario: session_stop crash dedupes per session

- **GIVEN** a `session_stop` payload with `session_id="abc-123"` and `crash_flag=true` fires a notification
- **AND** an erroneous duplicate `session_stop` for `session_id="abc-123"` arrives 60 seconds later
- **WHEN** `handleHooks` processes the duplicate
- **THEN** NO additional notification is dispatched
