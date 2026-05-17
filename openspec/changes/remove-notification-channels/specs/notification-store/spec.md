## REMOVED Requirements

### Requirement: tts channel synthesizer

**Reason for removal**: Per P4.5 (`swift-owns-elevenlabs-synth`), Swift app owns ElevenLabs synthesis end-to-end. The agent-side `channels/tts.ts` file (~254 lines) becomes dead code.

**Migration**: complete after P4.5 ships; `git rm apps/agent/src/notifications/channels/tts.ts`.

#### Scenario: tts.ts no longer exists
- **GIVEN** the removal is complete
- **WHEN** `ls apps/agent/src/notifications/channels/tts.ts`
- **THEN** the file does not exist (ENOENT)

### Requirement: desktop banner dispatcher

**Reason for removal**: Swift app uses native `UNNotificationCenter` for banners with proper click handling and notification grouping. The agent-side `terminal-notifier` invocation in `channels/desktop.ts` becomes dead code.

**Migration**: `git rm apps/agent/src/notifications/channels/desktop.ts`.

#### Scenario: desktop.ts no longer exists
- **GIVEN** the removal is complete
- **WHEN** `ls apps/agent/src/notifications/channels/desktop.ts`
- **THEN** the file does not exist (ENOENT)
