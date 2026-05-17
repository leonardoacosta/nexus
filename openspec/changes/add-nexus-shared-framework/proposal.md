---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Build NexusShared framework (Models + NexusClient + observers)

## Change ID
`add-nexus-shared-framework`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-0dxim)

## Summary
Implement the shared Swift framework targeting macOS + iOS + watchOS. Houses Models (Session, Notification, HealthSnapshot), NexusClient (SSE/WS subscriber, HTTP fetcher), telemetry observers, settings store.

## Context
- Adds: `apps/swift/NexusShared/` source dir + Swift package
- Reads from agent over Tailnet: SSE `/events/stream`, HTTP GET endpoints, WS PTY stream
- Depends-on: `xcodegen-initial-generate` (P4.1 · nx-4llis)

## Motivation
Three Apple targets sharing zero code would mean three implementations of every model. NexusShared is the single source of truth for Swift counterparts to the TS types in packages/db + packages/core.

## Requirements

### Requirement: NexusShared SHALL target macOS + iOS + watchOS

Per the XcodeGen manifest, NexusShared SHALL compile on macOS 14, iOS 17, watchOS 10.

### Requirement: NexusShared SHALL provide Models, NexusClient, Observers

Required public surface: Models/ (Session, Notification, HealthSnapshot Codable), NexusClient (SSE + HTTP), Observers/ (ObservableObject for SwiftUI), Storage/ (UserDefaults + Keychain).

#### Scenario: macOS target consumes the framework
- **WHEN** the menu bar app subscribes to NexusClient.events
- **THEN** SSE frames from homelab:7400 arrive as typed Swift events
