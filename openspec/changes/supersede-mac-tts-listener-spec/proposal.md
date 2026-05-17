# Proposal: Supersede consolidate-mac-tts-listener spec

## Change ID
`supersede-mac-tts-listener-spec`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-erjrg)

## Summary
Close the consolidate-mac-tts-listener spec with reason "Superseded by spine-migration P4 (Swift menu bar app absorbs all notifier+player+banner responsibilities)" and archive via the openspec archive workflow.

## Context
- Affects spec: `consolidate-mac-tts-listener` (5 open tasks)
- Affects beads: `nx-69d9s` under capability epic `nx-ga815` (mac-tts-listener)
- Depends-on: P4.5 + P4.7 (Swift owns notification surface end-to-end)

## Motivation
The consolidate-mac-tts-listener spec aimed to port banner-click-cancel from the decommissioned Bun listener to the bash listener. With the entire bash listener stack being replaced by the Swift app (P4.5+P4.7), porting to bash is wasted work. The Swift app implements banner-click-cancel natively via UNNotificationCenter actions.

## Requirements

### Requirement: spec SHALL be archived with explicit superseded reason

Use the openspec archive workflow (the project's /archive command) to move the proposal directory under `openspec/changes/archive/`. The beads feature `nx-69d9s` SHALL be closed with reason="Superseded by spine-migration P4".

#### Scenario: banner click cancels in Swift app
- **GIVEN** P4.5+P4.7 are merged
- **WHEN** Swift app fires a notification and user clicks the banner mid-playback
- **THEN** UNNotificationCenter delegate cancels in-flight AVAudioPlayer (no bash PID-file dance needed)
