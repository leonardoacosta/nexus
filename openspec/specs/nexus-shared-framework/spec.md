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

### Requirement: Banner presentation SHALL honor the in-app banner toggle

The `nx.notifications.bannerEnabled` user setting SHALL gate whether notification banners are
posted. When the setting is `false`, the framework's banner posters SHALL NOT post a banner;
when it is `true` or absent, banners SHALL post as before (the setting defaults to `true` for a
fresh install). The gate SHALL be applied at every banner poster — both
`TTSObserver.postBanner` and `SessionObserver.postLocalNotification` — and the macOS foreground
presentation handler (`NotificationActivationHandler.willPresent`) SHALL also honor the setting
so a suppressed notification is not force-presented in the foreground.

The setting SHALL be read directly from `UserDefaults.standard` using
`object(forKey:) as? Bool ?? true` (NOT `bool(forKey:)`, which would default an absent key to
`false` and suppress banners on a fresh install), matching the existing raw-UserDefaults read
precedent for ducking in `TTSObserver`.

Audio/TTS delivery SHALL be unaffected by the banner toggle — only the banner stage is gated.

#### Scenario: Toggle off suppresses the banner
- **WHEN** `nx.notifications.bannerEnabled` is `false` and a notification fires
- **THEN** no banner is posted by either poster
- **AND** the TTS/audio stage still plays

#### Scenario: Toggle on or absent posts the banner
- **WHEN** `nx.notifications.bannerEnabled` is `true` or has never been set
- **THEN** the banner posts as before

#### Scenario: Both posters honor the gate
- **WHEN** the toggle is off and a notification arrives via either the TTS observer or the session observer
- **THEN** neither poster posts a banner

