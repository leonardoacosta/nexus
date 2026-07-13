## ADDED Requirements

### Requirement: Non-critical TTS on the presence-unknown path SHALL respect a configurable quiet-hours window

`NotificationManager` MUST downgrade a `channel: "tts"` notification to `channel: "desktop"`
when `decidePresenceRoute()` returns `null` (presence-aware routing disabled, or the presence
vector has zero known fields) AND the current wall-clock hour falls within the configured
`[quietHoursStartHour, quietHoursEndHour)` window (supporting a window that wraps past
midnight) AND `quietHoursEnabled` is true. This check MUST run at both legacy delivery points:
`send()`'s immediate-delivery branch and `flush()`'s buffered-queue delivery. A
`priority: "high"` notification MUST NEVER be downgraded, regardless of the window. The
presence-aware rules engine's own Rule 1 (active-Mac-beats-bedtime) and Rule 3
(phone-reported bedtime) are unaffected — this gate is a floor for when no presence signal
exists at all, not a replacement for either rule.

#### Scenario: Non-critical TTS inside the quiet-hours window with no presence signal is downgraded

- **GIVEN** `quietHoursEnabled=true`, `quietHoursStartHour=0`, `quietHoursEndHour=7`
- **AND** the current wall-clock hour is 3
- **AND** presence-aware routing returns `null` (no known presence signal)
- **WHEN** a `channel: "tts"`, `priority` other than `"high"` notification is sent via the
  legacy delivery path
- **THEN** the notification is delivered with `channel: "desktop"` instead of `"tts"`

#### Scenario: A critical notification is never downgraded

- **GIVEN** the current wall-clock hour is within the configured quiet-hours window
- **WHEN** a `priority: "high"` notification (e.g. crash-stop, api-error) is sent via the
  legacy delivery path
- **THEN** the notification is still delivered with `channel: "tts"` unchanged

#### Scenario: Quiet hours disabled or unconfigured leaves legacy behavior unchanged

- **GIVEN** `quietHoursEnabled=false`, or `NotificationManager` was constructed with no
  `quietHours` wiring at all
- **WHEN** a non-critical `tts` notification is sent via the legacy delivery path at any hour
- **THEN** the notification is still delivered with `channel: "tts"` unchanged

#### Scenario: The quiet-hours window is operator-configurable via the settings route

- **GIVEN** a `PATCH /notifications/settings` request with body
  `{"quiet_hours_start_hour": 23, "quiet_hours_end_hour": 6}`
- **WHEN** the request is processed
- **THEN** the response reflects the updated window
- **AND** subsequent legacy-path deliveries use the new window
