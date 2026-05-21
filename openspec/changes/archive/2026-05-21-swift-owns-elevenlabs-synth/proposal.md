---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Swift app owns ElevenLabs synthesis end-to-end

## Change ID
`swift-owns-elevenlabs-synth`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-7ypvl)

## Summary
Move ElevenLabs key from agent's encrypted DB to macOS Keychain. Swift app calls api.elevenlabs.io directly. Agent emits text-only NotificationFired (no audioBase64).

## Context
- Modifies: `apps/agent/src/notifications.ts` (drop ElevenLabs call + audioBase64 field)
- Adds (Swift): Keychain access + ElevenLabs HTTP client in NexusShared
- Adds (Swift): AVAudioPlayer-based playback in nexus-mac
- Removes: `packages/db/src/schema/elevenlabsCredentials.ts`, decryption code path

## Motivation
Reduces agent secret-management surface to zero. Removes ~30KB base64 from every TTS envelope. Native AVAudioPlayer beats afplay subprocess management. Keychain is the right place for a per-user API key on macOS.

## Requirements

### Requirement: agent NotificationFired event SHALL NOT carry audioBase64

Envelope payload SHALL contain only `{id, title, body, channel, project, priority}` — no audio bytes.

### Requirement: Swift app SHALL synthesize on receipt

On NotificationFired via SSE, Swift app: checks local settings, calls ElevenLabs with Keychain key if TTS enabled, plays via AVAudioPlayer with ducking.

### Requirement: Keychain is the only ElevenLabs key store

`elevenlabsCredentials` table removed. Agent contains zero ElevenLabs references.

#### Scenario: notification fires with TTS enabled
- **WHEN** agent emits NotificationFired
- **THEN** Mac speaker plays voice within 2s; no audioBase64 was sent over wire
