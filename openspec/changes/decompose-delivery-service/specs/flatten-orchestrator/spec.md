# Spec: Flatten Orchestrator

## MODIFIED Requirements

### Requirement: Flatten process_speak_request nesting
The system MUST reduce `process_speak_request` from 5 nesting levels to max 2 by extracting the ElevenLabs
synthesis path into a helper and using early returns.

#### Scenario: ElevenLabs path extracted
Given the ElevenLabs code path (lines 263-316) is extracted to `try_elevenlabs_tts`
When `process_speak_request` is called with a valid API key and non-System mode
Then it calls `try_elevenlabs_tts` and returns on success
And falls through to system TTS on failure

#### Scenario: Early return for silent mode
When notification mode is Silent
Then `process_speak_request` returns `DeliveryResult::Skipped` immediately at the top
And no further processing occurs

#### Scenario: Early return for system mode
When notification mode is System
Then `process_speak_request` skips ElevenLabs entirely
And proceeds directly to system TTS fallback

#### Scenario: Chime playback separated
Given a project has a configured chime
When `process_speak_request` runs
Then chime playback is handled before TTS synthesis
And chime failure does not prevent TTS from proceeding (existing behavior preserved)

### Requirement: delivery.rs remains the thin orchestrator
After extraction, `delivery.rs` MUST contain only `process_speak_request`, `try_elevenlabs_tts` (helper),
the `ELEVENLABS_ALERT_SENT` static, and helper methods (`enrich_vague_message`, `format_message_with_project`).

#### Scenario: Line count target
When extraction is complete
Then `delivery.rs` is approximately 100-130 lines
And all extracted functions are reachable from their new module locations
