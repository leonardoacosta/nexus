# notification-store — Spec Delta

## ADDED Requirements

### Requirement: TTS channel restores ElevenLabs call and attaches audio to the lifecycle event

When `sendTtsNotification` is invoked with `ELEVENLABS_API_KEY` set, the channel MUST synthesize speech via ElevenLabs and attach the resulting mp3 bytes (base64-encoded) to the `NotificationFired` lifecycle event so downstream listeners (the Mac-side notifier, future iOS/iPad listeners) can render the audio natively. The channel MUST NOT gate the ElevenLabs call behind a secondary opt-in flag (the prior `NEXUS_TTS_USE_ELEVENLABS` env var is removed). The agent MUST NOT attempt to play the audio on the homelab host — the agent runs headless and has no audio sink.

When `ELEVENLABS_API_KEY` is unset, the channel MUST still mark the notification as delivered and emit `NotificationFired` with `audioBase64` absent, so listeners with their own TTS fallback (future: Slack bridge, mobile `AVSpeechSynthesizer`) still fire.

#### Scenario: ElevenLabs called, mp3 bytes surface in NotificationFired

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: "cc"`, `body: "build complete"` is queued
- **WHEN** the TTS channel dispatches
- **THEN** a POST is made to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>` with `text: "cc: build complete"`
- **AND** the response body (mp3 bytes) is captured
- **AND** `lifecycleBus.emit("NotificationFired", …)` is called with `audioBase64` set to the base64 encoding of those bytes

#### Scenario: No API key, text-only fire

- **GIVEN** `ELEVENLABS_API_KEY` is not set
- **AND** a notification with `channel: "tts"` is queued
- **WHEN** the TTS channel dispatches
- **THEN** no HTTP request is made to ElevenLabs
- **AND** the notification is marked `delivered`
- **AND** `NotificationFired` is emitted with `audioBase64` undefined

#### Scenario: ElevenLabs HTTP error does not emit audio

- **GIVEN** `ELEVENLABS_API_KEY` is set but the key is rejected (HTTP 401)
- **WHEN** the TTS channel dispatches
- **THEN** the error is captured to Sentry via the existing `captureException` path
- **AND** the notification is marked as failed on that channel
- **AND** `NotificationFired` MUST NOT be emitted for the failed TTS channel

### Requirement: NotificationFired payload MUST carry optional audio bytes

The `NotificationFiredPayload` type in `apps/agent/src/services/lifecycle-bus.ts` MUST include an optional `audioBase64?: string` field alongside the existing fields. When present, the value MUST be the base64 encoding of the raw mp3 bytes received from ElevenLabs. The field MUST be optional and subscribers MUST tolerate events where it is absent (text-only notifications).

#### Scenario: Payload type surface includes audioBase64

- **WHEN** a TypeScript consumer imports `NotificationFiredPayload` from `@nexus/agent`
- **THEN** the type MUST expose `audioBase64?: string` alongside `id`, `title`, `body`, `channel`, `project`, and `message`

#### Scenario: SSE subscriber receives the field

- **GIVEN** a client connected to `/events/stream` with `x-nexus-secret`
- **WHEN** a `NotificationFired` frame is emitted with `audioBase64` set
- **THEN** the SSE `data:` line MUST contain the full JSON envelope including `audioBase64`

### Requirement: Socket-server path remains consistent with audio-optionality

The legacy socket-based notification dispatcher at `apps/agent/src/services/socket-server/dispatcher.ts` MUST continue to emit `NotificationFired` for backward compatibility with the retired `/tmp/nexus-agent.sock` pattern. Since the socket path never had audio capture, it MUST explicitly omit `audioBase64` from the emission (or set it to `undefined`). This documents that the field is present-iff-via-HTTP-TTS-channel and avoids stale fields lingering from prior refactors.

#### Scenario: Socket dispatcher emits without audio

- **GIVEN** a legacy socket event triggers `NotificationFired` from the dispatcher
- **WHEN** the payload is constructed
- **THEN** `audioBase64` is explicitly undefined or omitted
- **AND** the listener skips audio playback on receipt
