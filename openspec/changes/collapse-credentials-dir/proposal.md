# Proposal: Collapse credentials/ directory (interim)

## Change ID
`collapse-credentials-dir`

## Phase
P1 consolidation (parent: spine-migration · nx-ma6h8 · feature: nx-jfbux)

## Summary
Replace the `apps/agent/src/credentials/` directory (8 files) with a single `cc-credential-manager.ts` placeholder, removing ElevenLabs-related code now that Swift will own it (P4.5).

## Context
- Deletes: `apps/agent/src/credentials/*.ts` (8 files including encryption, active-credential-watcher, token-stream)
- Creates: `apps/agent/src/cc-credential-manager.ts` (placeholder; full impl in P4.6)
- Related: `swift-owns-elevenlabs-synth` (P4.5 · nx-7ypvl), `add-cc-credential-manager` (P4.6 · nx-tsjwq)
- Removes references to: `packages/db/src/schema/elevenlabsCredentials.ts` (full removal in P4.5)

## Motivation
The `credentials/` directory was built for ElevenLabs key encryption + ad-hoc helpers. Interim collapse simplifies the file layout before the full P4.6 rewrite. ElevenLabs handling moves entirely to macOS Keychain owned by the Swift app.

## Requirements

### Requirement: cc-credential-manager.ts SHALL be the only agent-side credential file

After this change, the only file referencing Claude Code credentials in `apps/agent/src/` SHALL be `cc-credential-manager.ts`. The `credentials/` directory SHALL NOT exist.

#### Scenario: no orphaned ElevenLabs imports
- **GIVEN** the collapse is complete
- **WHEN** grep for `elevenlabs` across `apps/agent/src/`
- **THEN** zero matches (ElevenLabs code lives in Swift Keychain post-P4.5)
