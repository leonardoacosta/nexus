## ADDED Requirements

### Requirement: Mac Settings panes MUST persist toggles to the server, not just locally

Every Settings pane that displays a notification/TTS toggle backed by a `notification_settings` column MUST persist that toggle via `NexusClient.patchNotificationSettings()` using the server's snake_case field names, in addition to any local `UserDefaults`/`SettingsStore` cache. A pane MUST NOT rely on local persistence alone for a value that has a server-side column.

#### Scenario: SettingsTtsView toggle reaches the server

- **GIVEN** `SettingsTtsView` is open and `ttsEnabled` is currently `true` server-side
- **WHEN** the user toggles "TTS enabled" off
- **THEN** `NexusClient.patchNotificationSettings({"tts_enabled": false})` is called
- **AND** `GET /notifications/settings` subsequently returns `tts_enabled: false`

#### Scenario: NotificationsView's PATCH uses real field names

- **GIVEN** `NotificationsView` is open and the user changes meeting-mode, signal-only, or suppression-minutes
- **WHEN** `persist()` runs
- **THEN** the PATCH body uses `meeting_mode`, `signal_only`, `suppression_minutes` (not `meetingMode`/`signalOnly`/`suppressionMinutes`)
- **AND** the server responds `200 OK` (not `400`)

#### Scenario: A failed PATCH surfaces a visible error, not a false success

- **GIVEN** the agent is unreachable or returns a non-2xx response to a settings PATCH
- **WHEN** `persist()`'s PATCH call fails
- **THEN** the UI shows a visible error state
- **AND** the UI MUST NOT show "Saved" for a PATCH that did not succeed

### Requirement: TTSObserver MUST observe remote settings changes live

`TTSObserver` MUST subscribe to the agent's `SettingsChanged` SSE event (alongside its existing `NotificationFired`/`VoiceOverrideChanged` subscriptions) and update its in-memory gating state (`ttsEnabled`, `banner`, `ducking`, `signalOnly`) from the event payload when one arrives, without requiring an app restart.

#### Scenario: Remote PATCH updates the local listener without a restart

- **GIVEN** `TTSObserver` is running and `ttsEnabled` is currently `true`
- **WHEN** a `PATCH /notifications/settings {"tts_enabled": false}` succeeds from another process or machine
- **THEN** the agent broadcasts `SettingsChanged` with `ttsEnabled: false`
- **AND** `TTSObserver` updates its cached gating state within the SSE delivery window
- **AND** a subsequent `NotificationFired` TTS event is suppressed without requiring an app restart

#### Scenario: Local toggle is not overwritten by a stale echo

- **GIVEN** the user just toggled TTS off via `SettingsTtsView` on this machine
- **WHEN** the resulting `SettingsChanged` event (reflecting the same value) arrives back over SSE
- **THEN** `TTSObserver`'s gating state remains consistent (no flicker back to the old value)
