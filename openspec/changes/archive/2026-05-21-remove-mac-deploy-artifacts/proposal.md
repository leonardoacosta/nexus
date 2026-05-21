---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Remove Mac-side deploy artifacts (no more Mac agent)

## Change ID
`remove-mac-deploy-artifacts`

## Phase
P6 final-cleanup (parent: spine-migration · nx-ma6h8 · feature: nx-5ap2k)

## Summary
Delete all Mac-side daemon infrastructure: com.nexus.agent.plist, nexus-notifier.sh + plist, tts-player.plist, nexus-listener.ts (decommissioned), nexus-stub.swift (early exploration).

## Context
- Deletes: `deploy/com.nexus.agent.plist` (no Mac nexus-agent)
- Deletes: `deploy/nexus-notifier.sh` (bash listener replaced by Swift)
- Deletes: `deploy/com.nexus.notifier.plist`, `deploy/com.nexus.tts-player.plist`
- Deletes: `deploy/nexus-listener.ts` (decommissioned 2026-05-16 per memory)
- Deletes: `deploy/nexus-stub.swift` (early Swift exploration, subsumed by apps/swift/)
- Depends-on: P4 (Swift app owns notification surface) + P5 (no dashboard.service to depend on)

## Motivation
macOS becomes pure Swift app + Tailnet membership. Zero daemon infrastructure on Mac. Removes ~30KB of bash + multiple launchd plists + a 13KB stale TS file.

## Requirements

### Requirement: zero deploy/ files reference Mac-side daemons

After this change, `deploy/` SHALL contain no .plist files (no launchd entries) and no Mac-specific bash scripts.

### Requirement: launchd entries SHALL be unloaded before file deletion

Each plist's `launchctl unload ~/Library/LaunchAgents/<plist>` SHALL run before the deploy/ copy is deleted.

#### Scenario: Mac reboots cleanly with no Nexus daemons
- **GIVEN** deletion complete + launchd entries unloaded
- **WHEN** Mac reboots
- **THEN** zero Nexus processes appear in Activity Monitor (Swift app launches manually or via login items)
