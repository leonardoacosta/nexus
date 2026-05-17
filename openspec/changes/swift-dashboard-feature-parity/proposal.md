# Proposal: Swift dashboard reaches feature parity with web

## Change ID
`swift-dashboard-feature-parity`

## Phase
P5 web-deprecation (parent: spine-migration · nx-ma6h8 · feature: nx-urao8)

## Summary
Bring the Swift app's SwiftUI dashboard to feature parity with apps/nextjs. Cover every page the web has: specs, credentials, failures, notifications, projects, sessions, settings, health, integrations.

## Context
- Modifies: `apps/swift/nexus/nexus/` (extensive SwiftUI work)
- Uses: NexusShared (P4.2) for data + observers
- Adds: SwiftTerm-based PTY viewer reading /sessions/$id/stream WS
- Blocks: `retire-web-dashboard-infra` (P5.2 · nx-rguah) — web cannot be removed until parity

## Motivation
The web dashboard's full surface (xterm viewer, all pages, settings controls) is what kept it indispensable through v3. Native parity unblocks deletion.

## Requirements

### Requirement: Swift dashboard SHALL cover every web page

For each apps/nextjs page (sessions, specs, projects, credentials, failures, notifications, settings, health, integrations), the Swift app SHALL have an equivalent SwiftUI view exposing the same actions.

### Requirement: Swift dashboard SHALL include xterm-equivalent PTY viewer

A read-only terminal pane using SwiftTerm SHALL render `/sessions/$id/stream` bytes. Supports color, scrollback, copy/paste.

### Requirement: parity audit SHALL be checklist-verified before P5.2 starts

A docs/plan/spine-migration/p5-parity-audit.md file SHALL enumerate each web page and check off the Swift equivalent. P5.2 cannot start until all rows are checked.

#### Scenario: a user task achievable on web is achievable in Swift
- **GIVEN** any user action documented on apps/nextjs (e.g., "edit a notification setting")
- **WHEN** attempted in the Swift app
- **THEN** the same outcome is achievable with comparable UX
