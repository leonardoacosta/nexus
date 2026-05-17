# Proposal: Scaffold nexus-ios target (embeds SwiftTerm)

## Change ID
`scaffold-nexus-ios-target`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-qfqbx)

## Summary
Build the iOS app target. SwiftUI dashboard + APNS push + embedded SwiftTerm for in-app PTY attach over SSH.

## Context
- Adds: `apps/swift/nexus-ios/` source dir
- Dependencies: NexusShared framework (P4.2), SwiftTerm SPM (https://github.com/migueldeicaza/SwiftTerm)
- Depends-on: P4.1 + P4.2
- APNS: requires Apple Developer entitlement provisioning

## Motivation
Native iOS client. Embedded SwiftTerm means attach from the phone (over SSH+Tailnet) — including typing for permission grants and mid-flight commands. iOS has no terminal-app idiom, so we ship the terminal.

## Requirements

### Requirement: nexus-ios SHALL render the dashboard

Same dashboard panes as the macOS app (sessions, specs, health) using shared NexusShared views.

### Requirement: nexus-ios SHALL support PTY attach via SwiftTerm + SSH

Tapping "Attach" opens full-screen SwiftTerm view; SSH client (SwiftNIO-SSH or libssh2) connects, runs tmux attach, pipes I/O to SwiftTerm.

### Requirement: nexus-ios SHALL receive APNS push

On NotificationFired, an APNS push delivers to the device. Tap opens session detail.

#### Scenario: receive a notification on iPhone
- **WHEN** agent fires NotificationFired
- **THEN** within 2s the iPhone shows the push; tap opens session detail
