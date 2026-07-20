# notification-store — Delta

## MODIFIED Requirements

### Requirement: TTS channel restores ElevenLabs call and attaches audio to the lifecycle event

When `sendTtsNotification` is invoked with ElevenLabs credentials available and the resolved
project voice is bare or `elevenlabs:`-qualified, the channel MUST synthesize speech via
ElevenLabs and attach the resulting mp3 bytes (base64-encoded) to the `NotificationFired`
lifecycle event so downstream listeners (the Mac-side notifier, future iOS/iPad listeners)
can render the audio natively. The channel MUST NOT gate the ElevenLabs call behind a
secondary opt-in flag (the prior `NEXUS_TTS_USE_ELEVENLABS` env var is removed). The agent
MUST NOT attempt to play the audio on the homelab host — the agent runs headless and has no
audio sink.

When the resolved project voice is qualified with a provider other than `elevenlabs` (e.g.
`kokoro:af_heart`), the channel MUST NOT call ElevenLabs and MUST emit `NotificationFired`
with `audioBase64` absent — synthesis for local providers is owned by the Mac listener
(`mac-tts-listener`), not the headless agent.

When ElevenLabs credentials are unset, the channel MUST still mark the notification as
delivered and emit `NotificationFired` with `audioBase64` absent, so listeners with their own
TTS fallback (future: Slack bridge, mobile `AVSpeechSynthesizer`) still fire.

#### Scenario: ElevenLabs called, mp3 bytes surface in NotificationFired

- **GIVEN** `ELEVENLABS_API_KEY` is set
- **AND** a notification with `project: "cc"`, `body: "build complete"` is queued
- **AND** the resolved voice for `cc` is a bare ElevenLabs voice id
- **WHEN** the TTS channel dispatches
- **THEN** a POST is made to `https://api.elevenlabs.io/v1/text-to-speech/<voiceId>` with `text: "cc: build complete"`
- **AND** the response body (mp3 bytes) is captured
- **AND** `lifecycleBus.emit("NotificationFired", …)` is called with `audioBase64` set to the base64 encoding of those bytes

#### Scenario: Kokoro-qualified voice emits signal-only

- **GIVEN** ElevenLabs credentials are available
- **AND** the resolved project voice is `kokoro:af_heart`
- **WHEN** the TTS channel dispatches
- **THEN** no HTTP request is made to ElevenLabs
- **AND** the notification is marked `delivered`
- **AND** `NotificationFired` is emitted with `audioBase64` undefined

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
