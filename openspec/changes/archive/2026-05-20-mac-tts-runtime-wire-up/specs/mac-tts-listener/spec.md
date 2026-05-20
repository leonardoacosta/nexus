# mac-tts-listener Specification Delta

## ADDED Requirements

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
