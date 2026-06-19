# notification-store (delta: add-api-error-notification)

## ADDED Requirements

### Requirement: API errors MUST fire a desktop and TTS notification

The system MUST fire a notification on **every** Claude Code API error, covering two sources:

1. **Mid-session (retryable):** when a CC transcript line with `isApiErrorMessage: true`
   (e.g. `API Error: 529 Overloaded`) is observed while the session is still running, the
   tail-watcher MUST emit a `notification` event carrying the error text.
2. **Terminal crash:** when a session stops with `stop_reason="api_error"`, the same
   notification path MUST fire (this case previously fired desktop-only).

In both cases the notification MUST route to BOTH the `desktop` and `tts` channels with
`priority: high` and `severity: error`. The notification body MUST include the project code
and the captured API error text.

The `stop_reason="api_error"` crash case MUST be handled by the new API-error rule, not by
the generic session-stop rule; the session-stop rule MUST continue to handle all non-api
crash reasons (`error`, `crash`, `timeout`, `oom`).

#### Scenario: Mid-session 529 fires a spoken alert

- **GIVEN** a session is running and its transcript receives a line with
  `isApiErrorMessage: true` and content `"API Error: 529 Overloaded"`
- **WHEN** the tail-watcher reads that line
- **THEN** a `notification` event is emitted with the error text and project code
- **AND** the resulting notification routes to both `desktop` and `tts` channels with
  `severity: error`

#### Scenario: Crash-stop api_error now speaks

- **GIVEN** a session stops with `stop_reason="api_error"` and `error_details` present
- **WHEN** the hook rules evaluate the stop event
- **THEN** the API-error rule produces drafts for BOTH `desktop` and `tts` channels
- **AND** the generic session-stop rule produces no draft for `api_error`

#### Scenario: Non-api crash stays desktop-only

- **GIVEN** a session stops with `stop_reason="oom"`
- **WHEN** the hook rules evaluate the stop event
- **THEN** the session-stop rule produces a `desktop` draft as before
- **AND** the API-error rule produces no draft

### Requirement: API-error notification throttling

The system MUST throttle API-error notifications per session so that a sustained API outage
does not produce a stream of overlapping alerts. Repeated API errors for the same session
MUST be suppressed within the existing suppression window. The suppression key MUST be scoped
per session (`api_error:<session_id>`) so that distinct sessions hitting the same outage each
receive their own alert.

#### Scenario: Repeated 529s collapse to one alert

- **GIVEN** a session emits three `API Error: 529 Overloaded` lines within the suppression
  window
- **WHEN** the API-error rule evaluates each
- **THEN** only the first produces a delivered notification
- **AND** the second and third are suppressed by the per-session key

#### Scenario: Two sessions in the same outage both alert

- **GIVEN** two distinct sessions each emit an API error within the same window
- **WHEN** the API-error rule evaluates each
- **THEN** each session produces its own delivered notification (keys do not collide)
