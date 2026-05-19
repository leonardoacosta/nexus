# mac-tts-listener Specification Delta

## REMOVED Requirements

### Requirement: Drain worker publishes currently-playing audio pid to a shared file

**Reason for removal**: Bash listener + drain worker are obsolete. The Swift app
(`apps/swift/nexus-mac`) owns AVAudioPlayer playback in-process. No pid file IPC is
needed — the Swift player holds a direct reference to the in-flight audio player and
cancels it via UNNotificationCenter delegate callbacks.

#### Scenario: Swift player cancels in-process

- **GIVEN** the Swift Nexus.app is playing an AVAudioPlayer instance
- **WHEN** the user clicks the notification banner
- **THEN** the UNNotificationCenter delegate invokes `audioPlayer.stop()`
  in-process — no external pid file or launchd unit is involved

### Requirement: Banner dispatch attaches a kill-on-click target when a pid is current

**Reason for removal**: Banner-click-cancel landed natively in Swift via
`UNNotificationCenter` actions. No external pid handoff required.

#### Scenario: UNNotificationCenter handles cancel natively

- **GIVEN** the Swift app fires a notification with a cancel action
- **WHEN** the user invokes the cancel action
- **THEN** the delegate's `userNotificationCenter(_:didReceive:)` handler
  cancels the audio player; no pid lookup or external signal is required

### Requirement: Duplicate Bun TS listener artifacts SHALL be absent from this Mac

**Reason for removal**: Kept as a one-time operational cleanup, not a recurring
spec requirement. The Swift-owned posture makes the artifact-absence property
structural (no second subscriber to leak audio).

#### Scenario: Bun listener artifacts removed

- **WHEN** the operator runs `launchctl list | grep nexus-listener`
- **THEN** the output is empty
- **AND** `~/.local/share/nexus-listener.ts` does not exist
- **AND** `~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist`
  does not exist

### Requirement: A persistent memory note SHALL document the decommissioning

**Reason for removal**: bd memory `mac-tts-com-nexus-notifier-bash-deploy-nexus`
already updated 2026-05-19 to reflect the Swift-owned posture. Memory duty
satisfied; not a recurring spec requirement.

#### Scenario: bd memory reflects Swift ownership

- **WHEN** `bd memories tts` is run
- **THEN** the memory entry states "Swift app owns TTS end-to-end" and
  documents the action items if TTS is dead

### Requirement: Single-audio verification SHALL pass after decommissioning

**Reason for removal**: Double-audio (the original 2026-05-16 incident) was a
two-listener-subscribed-to-same-SSE bug. With ONE listener (Swift) and NO bash
or Bun fallback, double-audio is structurally impossible — no need for a
recurring verification.

#### Scenario: single subscriber is the structural guarantee

- **GIVEN** the Swift app is the only process subscribing to localhost:7400 `/events`
- **WHEN** a TTS notification is published
- **THEN** exactly one audio output is produced
- **AND** no other process can produce a duplicate because no other process
  exists in the architecture

## ADDED Requirements

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
