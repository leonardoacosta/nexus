## MODIFIED Requirements

### Requirement: agent credential code SHALL live in a single file

The agent's credential management code SHALL be implemented in `apps/agent/src/cc-credential-manager.ts` as a single module placeholder (full implementation in P4.6 `add-cc-credential-manager`). The `apps/agent/src/credentials/` directory SHALL NOT exist after this change. ElevenLabs-related code is removed entirely (moves to macOS Keychain via P4.5 `swift-owns-elevenlabs-synth`).

#### Scenario: no orphaned ElevenLabs imports
- **GIVEN** the collapse is complete
- **WHEN** `grep -r elevenlabs apps/agent/src/`
- **THEN** zero matches (ElevenLabs is Swift-owned post-P4.5)

#### Scenario: placeholder file exists
- **GIVEN** the collapse is complete
- **WHEN** typecheck runs against `apps/agent/`
- **THEN** the placeholder file resolves all credential-related imports (even if behavior is stubbed pending P4.6)
