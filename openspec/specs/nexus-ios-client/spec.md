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

### Requirement: The iOS session screen SHALL be a pushed navigation destination

The iOS live-session terminal screen SHALL be presented as a `.navigationDestination` pushed onto
the Sessions tab's navigation stack, not as a modal sheet. Navigation SHALL be driven by a session
path on the shared navigation model; appending a session id SHALL push the session screen, and the
stack's back affordance SHALL pop it. The session screen SHALL NOT wrap itself in its own
navigation stack and SHALL NOT present a modal `Close` control.

#### Scenario: Tapping a session row pushes the screen
- **WHEN** the user taps a session row in the Sessions list
- **THEN** the session screen is pushed onto the Sessions navigation stack
- **AND** the navigation bar shows a back button that pops back to the list

#### Scenario: Single navigation source of truth
- **WHEN** the session screen is presented
- **THEN** there is no root modal sheet presenting it
- **AND** exactly one navigation path drives the push

### Requirement: Deep links and notification taps SHALL push the session screen

Both `nexus://session/<id>` and `nexus://attach/<id>` URL verbs SHALL resolve to the same pushed
session screen by appending `<id>` to the session path. A notification tap (the
`.nexusOpenSessionDetail` event carrying a session id) SHALL likewise append to the session path.
When the originating action is outside the Sessions tab, the app SHALL select the Sessions tab
before pushing so the destination resolves on the correct stack.

#### Scenario: URL scheme pushes the session
- **WHEN** the app opens `nexus://session/<id>` or `nexus://attach/<id>`
- **THEN** the session screen for `<id>` is pushed onto the Sessions tab

#### Scenario: Notification tap from another tab
- **WHEN** a notification tap fires while a non-Sessions tab is active
- **THEN** the app selects the Sessions tab and pushes the session screen for the notification's session id

#### Scenario: Cold-launch deep link
- **WHEN** a deep link or notification tap arrives before the Sessions stack has mounted
- **THEN** the pending session id is retained and the push occurs once the stack is available

### Requirement: The dead session-detail and session-list scenes SHALL be removed

`SessionDetailScene` and `SessionListScene` SHALL be deleted along with all references to them, and
the Xcode project SHALL be regenerated. These scenes are not mounted in the active tab tree and the
`nexus://session` verb that targeted them is collapsed onto the pushed session screen.

#### Scenario: Build succeeds after removal
- **WHEN** the two scenes are deleted and references removed
- **THEN** the iOS target compiles with no dangling references to either scene

