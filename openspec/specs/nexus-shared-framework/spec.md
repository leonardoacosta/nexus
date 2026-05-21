# nexus-shared-framework Specification

## Purpose
TBD - created by archiving change add-nexus-shared-framework. Update Purpose after archive.
## Requirements
### Requirement: NexusShared SHALL be a multi-platform Swift framework

A new framework target `NexusShared` SHALL target macOS 14+, iOS 17+, and watchOS 10+. Source lives under `apps/swift/NexusShared/`. Per the XcodeGen manifest (apps/swift/project.yml), the framework SHALL be linked by all three app targets (nexus-mac, nexus-ios, nexus-watch).

#### Scenario: framework compiles on each target
- **GIVEN** the framework target is defined and source files exist
- **WHEN** xcodebuild compiles each platform
- **THEN** NexusShared.framework is produced for macOS, iOS-arm64, and watchOS-arm64

### Requirement: NexusShared SHALL provide Models, NexusClient, Observers

The framework SHALL expose: `Models/{Session, Notification, HealthSnapshot}.swift` (Codable structs mirroring TS schema types), `NexusClient.swift` (URLSession-based SSE subscriber + HTTP fetcher), `Observers/{SessionObserver, NotificationObserver}.swift` (ObservableObject for SwiftUI binding), `Storage/{SettingsStore, KeychainStore}.swift`.

#### Scenario: macOS app consumes NexusShared
- **GIVEN** the framework is built and linked into nexus-mac
- **WHEN** the macOS app imports NexusShared and subscribes via `NexusClient().events`
- **THEN** SSE frames from `homelab:7400/events/stream` arrive as typed Swift events

