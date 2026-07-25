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

The TTSObserver SHALL resolve synthesis through an ordered provider chain — Kokoro (when a
base URL is configured), then ElevenLabs (when a Keychain key and voice id are present),
then `AVSpeechSynthesizer`. When any provider attempt fails for ANY reason (missing
configuration, HTTP error, network failure, undersized response below 1024 bytes), the
TTSObserver MUST log the per-provider reason and advance to the next provider, terminating
at `AVSpeechSynthesizer` so the notification is always spoken.

#### Scenario: missing Keychain key falls back to native voice

- **GIVEN** no Kokoro base URL is configured
- **AND** Nexus.app Keychain does NOT contain an ELEVENLABS_API_KEY entry
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** the observer does NOT attempt any synthesis HTTP call
- **AND** `AVSpeechSynthesizer.speak` is invoked with the notification body text
- **AND** Console.app shows `TTSObserver: fallback to AVSpeechSynthesizer (reason: missing-key)`

#### Scenario: ElevenLabs HTTP 401 falls back

- **GIVEN** no Kokoro base URL is configured
- **AND** an invalid ELEVENLABS_API_KEY is configured
- **WHEN** a NotificationFired event arrives and ElevenLabsClient receives HTTP 401
- **THEN** the observer logs the failure
- **AND** `AVSpeechSynthesizer.speak` is invoked
- **AND** the user hears the notification body via the native macOS voice

#### Scenario: network failure falls back

- **GIVEN** no Kokoro base URL is configured
- **AND** the network is unreachable
- **WHEN** the ElevenLabs HTTP call fails with URLError
- **THEN** the observer logs the failure with the URLError code
- **AND** `AVSpeechSynthesizer.speak` is invoked

#### Scenario: Kokoro failure advances to ElevenLabs

- **GIVEN** a Kokoro base URL is configured but the server is unreachable
- **AND** a valid ELEVENLABS_API_KEY and voice id are configured
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** the observer logs the Kokoro failure reason
- **AND** ElevenLabs synthesis is attempted and its MP3 plays

#### Scenario: full chain exhaustion lands on system speech

- **GIVEN** a Kokoro base URL is configured but the server returns an undersized payload
- **AND** the ElevenLabs attempt fails with a network error
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** the observer logs both per-provider failure reasons
- **AND** `AVSpeechSynthesizer.speak` is invoked with the notification body text

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

Every UI surface that flips a notification/TTS setting — the Settings panes AND the NotificationDrawer quick toggles — SHALL persist the change to the agent via the settings PATCH so it round-trips through `SettingsChanged` to all peers. A local-only (`@AppStorage`-only) toggle write is a defect: the next inbound reconciliation silently reverts it.

#### Scenario: Drawer TTS quick-toggle persists

- **WHEN** the user flips the TTS toggle in the NotificationDrawer
- **THEN** the agent receives a settings PATCH carrying `tts_enabled`, and a subsequent inbound `SettingsChanged` reflects (not reverts) the user's choice

#### Scenario: Settings pane and drawer toggle are equivalent

- **WHEN** the same setting is flipped from the Settings pane or from the drawer
- **THEN** both paths produce the same PATCH and the same observer behavior

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

### Requirement: Kokoro is the preferred synthesis provider when configured

The TTSObserver SHALL attempt Kokoro synthesis before ElevenLabs whenever a Kokoro base URL
is configured. `KokoroClient` MUST conform to a shared `SpeechProvider` protocol
(`synthesize(text:voice:) async throws -> Data`, MP3 bytes) and call
`POST {baseUrl}/v1/audio/speech` with `{ model: "kokoro", input, voice, response_format: "mp3" }`
and an 8-second timeout, sending no auth header (the server is Tailscale-only). The voice
argument resolves from the `kokoroVoice` setting, defaulting to `af_heart`. `kokoroBaseUrl`
and `kokoroVoice` MUST be UserDefaults-backed settings editable from Nexus.app Settings
without a restart; no Keychain entry is involved.

#### Scenario: Kokoro success short-circuits ElevenLabs

- **GIVEN** a Kokoro base URL is configured and the server is reachable
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** the Kokoro response MP3 is handed to the platform MP3 player with ducking
- **AND** no ElevenLabs HTTP request is made

#### Scenario: Unconfigured Kokoro is skipped without an attempt

- **GIVEN** the Kokoro base URL setting is empty
- **WHEN** a NotificationFired event with channel="tts" arrives
- **THEN** no Kokoro HTTP request is made
- **AND** synthesis proceeds exactly as it does today (ElevenLabs when configured, else system speech)

### Requirement: Provider-qualified project voice overrides SHALL route synthesis to the matching provider
When the project voice override resolved for a notification is a qualified `provider:voice` string, the TTSObserver SHALL direct synthesis to the matching provider in the chain.
- `kokoro:`-qualified overrides drive the Kokoro attempt with the parsed voice (taking precedence over the global `kokoroVoice` setting).
- `elevenlabs:`-qualified and bare overrides drive the ElevenLabs attempt exactly as before.
- An override with an unknown provider prefix MUST be logged and treated as no override.
- The fallback chain semantics (failed attempt advances to the next provider, terminating at `AVSpeechSynthesizer`) are unchanged.

#### Scenario: Kokoro-qualified override speaks via Kokoro

- **GIVEN** the project voice override for `nx` is `kokoro:af_heart`
- **AND** a Kokoro base URL is configured and reachable
- **WHEN** a channel="tts" notification for project `nx` arrives
- **THEN** the Kokoro request carries `voice: "af_heart"`
- **AND** no ElevenLabs HTTP request is made

#### Scenario: Bare override keeps ElevenLabs behavior

- **GIVEN** the project voice override for `cc` is a bare ElevenLabs voice id
- **AND** an ElevenLabs key is configured
- **WHEN** a channel="tts" notification for project `cc` arrives
- **THEN** the ElevenLabs attempt uses that voice id, matching pre-change behavior

#### Scenario: Unknown prefix degrades to no override

- **GIVEN** the project voice override for `xy` is `nope:whatever`
- **WHEN** a channel="tts" notification for project `xy` arrives
- **THEN** the observer logs the unknown provider
- **AND** synthesis proceeds as if no project override existed

### Requirement: Pipeline TTS Playback MUST Be Identifiable and Stoppable
The system MUST associate a pipeline-originated TTS clip with the notification id that triggered
it, and MUST expose a working stop control for that clip through the same UI surface used for
manual replay.

#### Scenario: Stop control appears during live pipeline playback
- **GIVEN** `TTSObserver` is speaking a notification via the synth provider chain
- **WHEN** the corresponding notification row is rendered
- **THEN** it shows `stop.circle` (not `play.circle`), matching the manual-replay row's existing
  icon convention

#### Scenario: Tapping stop halts the clip without starting a new one
- **GIVEN** a pipeline clip is playing and its row shows `stop.circle`
- **WHEN** the user taps it
- **THEN** the clip halts immediately and no new clip begins as a side effect

### Requirement: Back-to-Back TTS Events MUST Be Coordinated, Not Independent
The system MUST NOT allow two `tts`-channel `NotificationFired` events arriving within the same
synth-latency window to synthesize and start playback with no coordination between them.

#### Scenario: Second event waits for the first to finish
- **GIVEN** a pipeline clip is already playing
- **AND** a second `tts` event is received before it finishes
- **WHEN** the second event is handled
- **THEN** its synthesis and playback are deferred until the first clip's `onPlaybackFinished`
  fires, then it plays in full (queue-and-play-sequentially — decided in tasks.md task 1.1,
  by:leo) — never an uncoordinated race with the first clip

### Requirement: Synthesis failures never crash the listener

Every failure on the TTS synthesis path — including a malformed or non-URL-safe voice id from a project voice override — SHALL surface as a thrown error that the provider chain catches and degrades from, never as a force-unwrap trap.

#### Scenario: Malformed voice override degrades gracefully

- **WHEN** a project voice override resolves to a voice id that cannot form a valid request URL
- **THEN** the ElevenLabs client throws, the provider chain advances (or degrades to signal-only), and the app does not crash

### Requirement: Replay playback state tracks the audible clip

The replay UI's playing-state (`currentlyPlayingId`) SHALL always name the clip that is actually audible. When a live TTS clip supersedes a manual replay, the superseded replay's id is cleared immediately — not at clip end.

#### Scenario: Live clip supersedes a manual replay

- **WHEN** a manual replay is playing and a live TTS clip supersedes it
- **THEN** the replay row's stop icon reverts to play, and tapping the row does not stop the unrelated live clip

