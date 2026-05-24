## ADDED Requirements

### Requirement: On-device speech recognition with explicit start/stop

A `SpeechController` MUST wrap `SFSpeechRecognizer` + `AVAudioEngine` to capture microphone audio and produce a transcript. It MUST set `requiresOnDeviceRecognition = true` (no audio leaves the device), expose `start()` and `stop()` (stop finalizes the transcript), and request microphone + speech-recognition authorization lazily on first use. If authorization is denied or the recognizer is unavailable, start MUST fail gracefully (logged, no crash).

#### Scenario: Start then stop yields a transcript

- **GIVEN** mic + speech authorization is granted
- **WHEN** `start()` is called, the user speaks "run the tests", and `stop()` is called
- **THEN** the controller finalizes a transcript containing "run the tests"

#### Scenario: Denied authorization fails gracefully

- **GIVEN** speech-recognition authorization is denied
- **WHEN** `start()` is called
- **THEN** it logs the denial and returns without crashing; no recording begins

#### Scenario: On-device only

- **WHEN** a recognition request is created
- **THEN** `requiresOnDeviceRecognition` is `true` so no audio is sent to Apple servers

### Requirement: AirPods double-press starts dictation; a following press stops and sends

Within the Now-Playing window (TTS playback + 2s grace, established by `airpods-tts-cancel`), an `MPRemoteCommandCenter.nextTrackCommand` (AirPods double-press) MUST start STT recording. While recording, the next remote-command press MUST stop recording and send the transcript. The command MUST be consumed (not propagated to other media apps).

#### Scenario: Double-press starts recording

- **GIVEN** a TTS clip just played and the app owns the Now-Playing session
- **WHEN** the user double-presses the AirPods stem (next-track)
- **THEN** STT recording starts and a recording indicator is shown

#### Scenario: Next press stops and sends

- **GIVEN** STT recording is active (started via double-press)
- **WHEN** the user presses the AirPods stem again
- **THEN** recording stops, the transcript is finalized, and it is routed to the target session

#### Scenario: Double-press outside the Now-Playing window is a no-op

- **GIVEN** no TTS has played recently (Now-Playing window inactive)
- **WHEN** the AirPods next-track gesture fires
- **THEN** the app does not start recording (it is not the Now-Playing source; the command routes to the user's music app as normal)

### Requirement: The transcript MUST route to the last-notified TTS session

`TTSObserver` MUST record the project + session of the most recent `NotificationFired` event. When a dictation finalizes, the transcript MUST be sent to that session via `POST /commands/send-text` (Swift `NexusClient.sendText`). If no session can be resolved, the transcript MUST be surfaced in a banner instead (fail-safe — never silently dropped).

#### Scenario: Transcript injected into the speaking session

- **GIVEN** session X (project "oo") fired the last TTS notification
- **WHEN** the user dictates "continue" and it finalizes
- **THEN** "continue" is sent via `send-text` to session X's tmux pane

#### Scenario: No resolvable session falls back to a banner

- **GIVEN** the last notification had no resolvable session id
- **WHEN** a transcript finalizes
- **THEN** the transcript is shown in a banner and NOT silently dropped
