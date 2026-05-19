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

