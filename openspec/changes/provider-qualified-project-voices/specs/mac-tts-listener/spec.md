# mac-tts-listener — Delta

## ADDED Requirements

### Requirement: Provider-qualified project voice overrides route synthesis to the matching provider

When the project voice override resolved for a notification is a qualified
`provider:voice` string, the TTSObserver SHALL direct synthesis to the matching provider in
the chain: `kokoro:`-qualified overrides drive the Kokoro attempt with the parsed voice
(taking precedence over the global `kokoroVoice` setting); `elevenlabs:`-qualified and bare
overrides drive the ElevenLabs attempt exactly as before. An override with an unknown
provider prefix MUST be logged and treated as no override. The fallback chain semantics
(failed attempt advances to the next provider, terminating at `AVSpeechSynthesizer`) are
unchanged.

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
