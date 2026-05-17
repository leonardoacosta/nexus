# Proposal: Remove notifications/channels/{tts,desktop}.ts

## Change ID
`remove-notification-channels`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-bn8we)

## Summary
Delete `apps/agent/src/notifications/channels/tts.ts` (~254 lines) and `channels/desktop.ts` now that Swift owns synthesis (P4.5) and uses UNNotificationCenter for banners.

## Context
- Deletes: tts.ts + desktop.ts
- Depends-on: `swift-owns-elevenlabs-synth` (P4.5 · nx-7ypvl)
- Updates: collapsed notifications.ts (P1.1) — drop tts + desktop route cases

## Motivation
With Swift owning synthesis and using native UNNotificationCenter, the agent-side channel files are dead code.

## Requirements

### Requirement: channels/ directory SHALL be empty after this change

After deletion, `apps/agent/src/notifications/channels/` SHALL contain no files. P1.1 collapse handles full directory removal.

#### Scenario: agent no longer makes ElevenLabs calls
- **WHEN** the agent process is profiled
- **THEN** zero outbound connections to api.elevenlabs.io
