# mac-tts-listener Specification

## Purpose
TBD - created by archiving change consolidate-mac-tts-listener. Update Purpose after archive.
## Requirements
### Requirement: Swift app is the sole owner of macOS TTS

The Swift app SHALL be the sole owner of the macOS TTS pipeline. The full
chain (utterance receipt -> synthesis -> playback -> banner + cancel) MUST be
implemented entirely within `apps/swift/nexus-mac` and its shared framework
`NexusShared`. No external listener process (bash, Bun, or otherwise) SHALL
subscribe to the agent's `/events` SSE stream for TTS purposes.

#### Scenario: only one launchd unit handles agent SSE

- **WHEN** `launchctl list` is run on a Mac with Nexus installed
- **THEN** no unit named `com.leonardoacosta.nexus-listener`,
  `com.nexus.notifier`, or any other listener is loaded
- **AND** only the Swift app (`Nexus.app`, not a launch agent) subscribes to
  the agent's `/events` SSE endpoint

#### Scenario: nx_notify utterances are spoken by Swift

- **GIVEN** the Swift Nexus.app is running and subscribed to /events
- **WHEN** a `notification` event with `channels: ["tts"]` is published to
  the agent
- **THEN** the Swift app's TTS subscriber receives the event
- **AND** invokes AVSpeechSynthesizer (or ElevenLabs synth per P4.5) to speak
  the message
- **AND** registers a UNNotificationCenter banner with cancel action

#### Scenario: no bash or Bun fallback path exists

- **GIVEN** the Swift app is the sole owner of TTS
- **WHEN** the operator inspects the deploy artifacts
- **THEN** no `deploy/nexus-notifier.sh` or equivalent bash listener exists
- **AND** no Bun listener source file exists at `~/.local/share/nexus-listener.ts`

### Requirement: Swift app runs a TTSObserver at @main App init

The Swift app SHALL run a TTSObserver at @main App init. The Nexus.app
macOS target MUST instantiate a `TTSObserver` (or equivalent
window-independent observer) at `@main App init` so that the
NotificationFired SSE subscription begins on app launch and runs regardless
of whether the dashboard window is presented.

#### Scenario: observer starts on cold launch without dashboard window

- **GIVEN** Nexus.app is launched as LSUIElement (menu-bar only, no Dock window)
- **AND** the user does NOT click the menu bar icon to open the dashboard
- **WHEN** a NotificationFired event with channel="tts" is broadcast on `/events/stream`
- **THEN** the TTSObserver receives the event within 2 seconds
- **AND** the observer's handler is invoked
- **AND** Console.app shows `TTSObserver: received id=...` log entry

#### Scenario: observer survives dashboard window close/reopen

- **GIVEN** TTSObserver is running and a user has opened then closed the dashboard window
- **WHEN** a NotificationFired event arrives after the window close
- **THEN** the observer still processes the event (subscription is independent of window lifecycle)

### Requirement: macOS notification permission requested at app launch

Nexus.app SHALL request macOS notification authorization at app launch.
On Nexus.app launch, `UNUserNotificationCenter.current().requestAuthorization`
MUST be called with `[.alert, .sound]` options. The request MUST be
non-blocking (async with completion handler).

#### Scenario: first launch presents system prompt

- **GIVEN** Nexus.app has never been launched on this macOS user account
- **WHEN** the user launches Nexus.app
- **THEN** macOS displays the standard notification authorization prompt within 2 seconds of launch
- **AND** the prompt offers "Allow" / "Don't Allow" actions

#### Scenario: subsequent launches do NOT re-prompt

- **GIVEN** the user has previously granted (or denied) notification permission for Nexus.app
- **WHEN** Nexus.app is launched again
- **THEN** macOS does NOT re-prompt
- **AND** the app proceeds without blocking

#### Scenario: denied permission produces audio-only delivery

- **GIVEN** the user denied notification permission
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** no banner is shown
- **AND** audio playback still occurs (ElevenLabs or AVSpeechSynthesizer fallback)
- **AND** the observer logs `TTSObserver: banner suppressed (permission denied)` once per app launch

### Requirement: TTS synthesis falls back to AVSpeechSynthesizer

The TTSObserver SHALL fall back to AVSpeechSynthesizer when ElevenLabs
synthesis fails. When the primary ElevenLabs synthesis path fails for ANY
reason (missing Keychain key, HTTP error, network failure, undersized
response), the TTSObserver MUST fall back to `AVSpeechSynthesizer` so the
notification is spoken via the native macOS voice.

#### Scenario: missing Keychain key falls back to native voice

- **GIVEN** Nexus.app Keychain does NOT contain an ELEVENLABS_API_KEY entry
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** the observer does NOT attempt ElevenLabs HTTP call
- **AND** `AVSpeechSynthesizer.speak` is invoked with the notification body text
- **AND** Console.app shows `TTSObserver: fallback to AVSpeechSynthesizer (reason: missing-key)`

#### Scenario: ElevenLabs HTTP 401 falls back

- **GIVEN** an invalid ELEVENLABS_API_KEY is configured
- **WHEN** a NotificationFired event arrives and ElevenLabsClient receives HTTP 401
- **THEN** the observer logs the failure
- **AND** `AVSpeechSynthesizer.speak` is invoked
- **AND** the user hears the notification body via the native macOS voice

#### Scenario: network failure falls back

- **GIVEN** the network is unreachable
- **WHEN** the ElevenLabs HTTP call fails with URLError
- **THEN** the observer logs the failure with the URLError code
- **AND** `AVSpeechSynthesizer.speak` is invoked

### Requirement: Banner posts via UNUserNotificationCenter regardless of synth outcome

The TTSObserver SHALL post a banner via UNUserNotificationCenter for every
NotificationFired event with channel="tts" where permission is granted. For
every such event, the banner MUST be posted via
`UNUserNotificationCenter.current().add(UNNotificationRequest(...))` BEFORE
synth begins. The banner posting MUST NOT depend on or wait for the synth
result.

#### Scenario: banner appears even on synth failure

- **GIVEN** ElevenLabs returns HTTP 500 (server error)
- **WHEN** a NotificationFired event arrives
- **THEN** the macOS banner appears with the title and body within 500ms
- **AND** the AVSpeechSynthesizer fallback speaks the body shortly after

#### Scenario: banner identifier uses event id

- **GIVEN** a NotificationFired event with `id: "cc-1779249101-23921"`
- **WHEN** the observer posts the banner
- **THEN** the UNNotificationRequest identifier equals the event id
- **AND** subsequent duplicate events with the same id replace the existing banner (UNUserNotificationCenter coalesces by identifier)

### Requirement: TTSObserver emits os_log at every pipeline stage

The TTSObserver SHALL emit os_log entries at every pipeline stage. The
TTSObserver MUST emit `os_log` entries at each of: event receipt, filter
decision, banner attempt, synth start, synth result (success or failure),
playback start. Logs MUST use `%{public}@` formatters for event ids and
channel names so Console.app shows them un-redacted.

#### Scenario: Console.app shows full pipeline trace

- **GIVEN** a developer is watching Console.app filtered by `process:nexus`
- **WHEN** a single NotificationFired event flows through the observer
- **THEN** at least 5 log entries appear with the format `TTSObserver: <stage> ...`
- **AND** the event id appears in at least the receipt and banner entries
- **AND** the synth path taken (elevenlabs OR fallback) is visible from the log entries

#### Scenario: failure path is debuggable from logs alone

- **GIVEN** TTS is not firing on a user's machine
- **WHEN** the developer asks the user to share Console.app output
- **THEN** the logs reveal exactly which stage failed (no-key, http-error, audio-error)
- **AND** no additional instrumentation is needed

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

