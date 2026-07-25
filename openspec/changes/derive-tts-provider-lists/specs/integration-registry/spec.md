# Integration Registry

## ADDED Requirements

### Requirement: TTS-capable provider membership derives from a single source

`TTS_VOICE_PROVIDERS` SHALL be derived from a single declared TTS-capable subset of `INTEGRATION_PROVIDERS` plus the documented legacy `elevenlabs` entry — never hand-maintained as an independent list. Registry descriptors and core provider lists SHALL be tied by an assertion test.

#### Scenario: New TTS provider needs one edit

- **WHEN** a new TTS-capable provider is added to the declared subset (and its registry descriptor)
- **THEN** the project-voices route accepts its qualified `provider:voice` ids with no separate `TTS_VOICE_PROVIDERS` edit

#### Scenario: Core/registry drift fails fast

- **WHEN** a provider descriptor is registered whose key is missing from `INTEGRATION_PROVIDERS`
- **THEN** a test fails at CI time, rather than voice writes 400ing at runtime
