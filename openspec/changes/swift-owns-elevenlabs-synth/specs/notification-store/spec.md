## MODIFIED Requirements

### Requirement: NotificationFired SHALL carry text-only payload

The `NotificationFired` envelope payload SHALL contain only `{id, title, body, channel, project, priority}` — no `audioBase64` field. Audio synthesis is performed by the Swift app on receipt; the agent emits text only.

#### Scenario: envelope is small
- **GIVEN** the agent processes a notification dispatch
- **WHEN** the resulting NotificationFired envelope is inspected
- **THEN** it contains no `audioBase64` field; total envelope size is under 1KB

### Requirement: agent SHALL NOT call ElevenLabs

The agent codebase SHALL contain zero references to `api.elevenlabs.io`, `xi-api-key`, or any ElevenLabs SDK/client. The `elevenlabsCredentials` Drizzle schema SHALL be dropped.

#### Scenario: outbound traffic shows zero ElevenLabs connections
- **GIVEN** the agent is running for 24h after this change
- **WHEN** outbound TCP connections from the agent process are inspected
- **THEN** zero connections to api.elevenlabs.io are recorded

## REMOVED Requirements

### Requirement: agent-side ElevenLabs synthesis

**Reason for removal**: Synthesis moves to the Swift app, which holds the ElevenLabs API key in macOS Keychain (proper secret storage). Agent loses an entire encryption codepath and ~30KB-per-notification base64 bloat.

**Migration**: existing `elevenlabs_credentials` DB row content is exported manually and pasted into the Swift app's Settings UI on first launch; then `DROP TABLE elevenlabs_credentials`.
