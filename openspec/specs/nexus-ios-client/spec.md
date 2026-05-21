# nexus-ios-client Specification

## Purpose
TBD - created by archiving change scaffold-nexus-ios-target. Update Purpose after archive.
## Requirements
### Requirement: nexus-ios SHALL be a native iOS app target

A new iOS app target `nexus-ios` SHALL be defined in `apps/swift/project.yml` and scaffolded under `apps/swift/nexus-ios/`. Target iOS 17+. Bundle ID per manifest. Links the `NexusShared` framework.

#### Scenario: iOS target compiles
- **GIVEN** the target is defined and source files exist
- **WHEN** xcodebuild compiles the nexus-ios scheme
- **THEN** the .app is produced and runs on iOS simulator

### Requirement: nexus-ios SHALL render the dashboard via SwiftUI

The iOS app SHALL display the same dashboard panes as the macOS app (sessions, specs, health) using SwiftUI views from NexusShared where shareable. Sessions list is the default landing scene.

#### Scenario: sessions list renders
- **GIVEN** the app is launched and connected to homelab
- **WHEN** SSE delivers a Session list snapshot
- **THEN** the sessions list scene renders one row per session

### Requirement: nexus-ios SHALL embed SwiftTerm for in-app PTY attach

Tapping "Attach" on a session SHALL open a full-screen view rendering a SwiftTerm TerminalView. Behind it, an SSH client (SwiftNIO-SSH or libssh2) connects to the session's machine, runs `tmux attach -t <target>`, and pipes I/O to SwiftTerm.

#### Scenario: attach to a homelab tmux session
- **GIVEN** a session `oo-7f3a` is running on homelab with tmux target `cc-oo:0.0`
- **WHEN** the user taps "Attach" in nexus-ios
- **THEN** within 3s a full-screen SwiftTerm view shows the live tmux pane output and accepts keyboard input

### Requirement: nexus-ios SHALL receive APNS push notifications

The app SHALL register for APNS push notifications. When the agent fires a `NotificationFired` event, an APNS push SHALL deliver to the device. Tapping the push SHALL deep-link to the session detail.

#### Scenario: push notification received and tappable
- **GIVEN** the iOS app is installed, signed in, APNS provisioned
- **WHEN** the agent fires NotificationFired for session `oo-7f3a`
- **THEN** within 2s the iPhone shows the push; tapping opens the `oo-7f3a` detail scene

