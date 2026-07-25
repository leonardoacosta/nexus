# Notification Store

## ADDED Requirements

### Requirement: TTS synthesis failure degrades to signal-only delivery

A TTS synthesis failure — provider HTTP error, missing credential, or voice-resolution error — SHALL NOT drop or fail the notification: the channel degrades to signal-only delivery (no `audioBase64`), and this contract is pinned by direct channel-level regression tests, not only router-level timeout coverage.

#### Scenario: Provider HTTP error degrades

- **WHEN** the synthesis provider returns a 5xx during TTS rendering
- **THEN** the notification is still delivered signal-only, with no thrown error escaping the channel

#### Scenario: Missing credential degrades

- **WHEN** no synthesis credential is available
- **THEN** the notification is delivered signal-only

#### Scenario: Voice-resolution failure degrades

- **WHEN** resolving the project voice override throws
- **THEN** the notification is delivered signal-only

### Requirement: Voice-id length cap is regression-tested at the route

The `PUT /notifications/voices` over-length rejection (`VOICE_ID_MAX`) SHALL have route-level test coverage so the input cap cannot be silently dropped.

#### Scenario: Over-length voice id rejected

- **WHEN** a `voice_id` exceeding `VOICE_ID_MAX` characters is submitted
- **THEN** the route responds 400 with an error naming the cap
