# Spec: DeliveryResult Type

## ADDED Requirements

### Requirement: DeliveryResult enum replaces tuple return
The system MUST define `DeliveryResult` in `types.rs` to replace the `(bool, Option<String>, Option<String>)` return type from `process_speak_request`.

#### Scenario: Successful ElevenLabs delivery
When ElevenLabs TTS succeeds and audio plays
Then `process_speak_request` returns `DeliveryResult::Played { message: "Played via ElevenLabs", provider: "elevenlabs" }`

#### Scenario: Successful system TTS delivery
When system TTS fallback succeeds
Then `process_speak_request` returns `DeliveryResult::Played { message: "Played via say", provider: "say" }`

#### Scenario: Silent mode skip
When notification mode is Silent
Then `process_speak_request` returns `DeliveryResult::Skipped { reason: "Skipped (silent mode)" }`

#### Scenario: All TTS methods fail
When both ElevenLabs and system TTS fail
Then `process_speak_request` returns `DeliveryResult::Failed { error: "..." }`

## MODIFIED Requirements

### Requirement: Callers adopt DeliveryResult matching
`playback_queue.rs` at lines 151 and 240 MUST destructure `DeliveryResult` with `match` instead of tuple positional access.

#### Scenario: playback_queue success handling
Given `process_speak_request` returns `DeliveryResult::Played { message, provider }`
When `process_single` handles the result
Then it logs the message and provider
And proceeds with iMessage escalation check

#### Scenario: playback_queue failure handling
Given `process_speak_request` returns `DeliveryResult::Failed { error }`
When `process_single` handles the result
Then it logs the error
And does not attempt iMessage escalation
