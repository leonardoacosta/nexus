# Proposal: Run xcodegen generate against apps/swift/project.yml

## Change ID
`xcodegen-initial-generate`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-4llis)

## Summary
Audit the existing Xcode project signing/team settings, then run `cd apps/swift && xcodegen generate` to regenerate `nexus.xcodeproj` from the YAML manifest.

## Context
- Modifies: `apps/swift/nexus.xcodeproj/project.pbxproj` (REPLACED by xcodegen)
- Reads: `apps/swift/project.yml` (the manifest, shipped 2026-05-17)
- User action: must audit signing/team/capabilities in current .pbxproj BEFORE regeneration

## Motivation
The manifest is in place but the project.pbxproj is still hand-managed. Regenerating from YAML is the gate that unlocks all subsequent P4 work.

## Requirements

### Requirement: post-regeneration build SHALL succeed

After `xcodegen generate`, `xcodebuild -scheme nexus-mac` SHALL succeed without modification. Existing tests SHALL pass.

#### Scenario: existing menu bar app still builds and runs
- **GIVEN** xcodegen generate has run
- **WHEN** Leo opens nexus.xcodeproj in Xcode and builds the macOS scheme
- **THEN** build succeeds, app launches, menu bar icon appears as before
