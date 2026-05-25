# test-infrastructure

## ADDED Requirements

### Requirement: Mac-TTS delivery path has a deterministic integration test

An integration-test harness SHALL drive the existing `stub-agent` to emit a controlled `NotificationFired` SSE event and MUST assert that the Swift TTS observer consumes the event and invokes the audio/synthesis path. The harness MUST mock the actual player so the assertion is deterministic, and it MUST skip cleanly when audio hardware is unavailable.

#### Scenario: NotificationFired drives playback synthesis

- **WHEN** the harness directs the `stub-agent` to emit a `NotificationFired` SSE event
- **THEN** the Swift TTS observer SHALL consume the event and invoke the mocked audio/synthesis path exactly once with the event's text
- **AND** the assertion SHALL be deterministic with no dependence on real audio output

#### Scenario: Harness skips on hardware without audio

- **WHEN** the harness runs on a CI runner that reports no available audio hardware
- **THEN** the test SHALL be marked skipped rather than failing
- **AND** the skip reason SHALL indicate audio hardware is unavailable

#### Scenario: Round-trip assertion is reproducible

- **WHEN** the harness is executed repeatedly against the same stub-agent event
- **THEN** each run SHALL assert the same `NotificationFired` → playback round-trip outcome
- **AND** no run SHALL pass or fail nondeterministically due to timing
