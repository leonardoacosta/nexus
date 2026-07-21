# mac-tts-listener — Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
