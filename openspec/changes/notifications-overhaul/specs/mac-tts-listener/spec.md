# mac-tts-listener Delta

## ADDED Requirements

### Requirement: tts-observer-project-voice-resolution
The `TTSObserver` MUST resolve the voice id for each notification using this priority chain: (1) per-project override from `GET /notifications/voices` if `notification.project` matches a mapped slug; (2) global Keychain `elevenLabsVoiceId`; (3) system synthesis fallback when no key/voice is set. The observer MUST cache the project-voice map at startup and MUST refresh the cache on `VoiceOverrideChanged` SSE events.

#### Scenario: project override wins
- **Given** the cache has `{ nx: "voice-A" }` and Keychain global voice is `voice-GLOBAL`
- **When** a notification arrives with `project: "nx"`
- **Then** synthesis uses `voice-A`; emitted `voiceUsed` field is `"voice-A"`

#### Scenario: fallback to global
- **Given** the cache has `{ nx: "voice-A" }` (no oo entry)
- **When** a notification arrives with `project: "oo"`
- **Then** synthesis uses Keychain `voice-GLOBAL`

#### Scenario: nil project uses global
- **Given** a system notification with `project: nil`
- **When** the observer processes it
- **Then** the lookup skips per-project resolution and falls straight to the Keychain global

#### Scenario: SSE event refreshes cache
- **Given** the observer's cache is `{ nx: "voice-A" }`
- **When** a `VoiceOverrideChanged { project: "nx" }` SSE event arrives
- **Then** the observer re-fetches `GET /notifications/voices` and the cache reflects the new value for the next notification

#### Scenario: system fallback when keys missing
- **Given** Keychain has no `elevenLabsApiKey`, and no override matches
- **When** a notification arrives
- **Then** synthesis routes to system speech (`SystemSpeechSynthesizer`); `voiceUsed` is `null` in the persisted row
