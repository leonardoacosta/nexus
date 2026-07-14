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

Tapping "Attach" on a session SHALL open a full-screen view rendering a SwiftTerm TerminalView. Behind it, an SSH client (SwiftNIO-SSH or libssh2) connects to the session's machine, runs `tmux attach -t <target>`, and pipes I/O to SwiftTerm. Every keystroke sent via `SshTerminalSession.send()` MUST reach the owning agent's `pty.write()` as a binary interact frame — a client-side "send success" log with no corresponding agent-side interact-frame receipt indicates a regression, not a passing state.

#### Scenario: attach to a homelab tmux session
- **GIVEN** a session `oo-7f3a` is running on homelab with tmux target `cc-oo:0.0`
- **WHEN** the user taps "Attach" in nexus-ios
- **THEN** within 3s a full-screen SwiftTerm view shows the live tmux pane output and accepts keyboard input

#### Scenario: keystrokes reach the agent's PTY (nx-qq3qu regression guard)
- **GIVEN** a single-`dashboardEndpoint`-mode agent owns session `oo-7f3a`
- **WHEN** `SshTerminalSession.send()` logs `NXPTY send bytes=N` and reports client-side success
- **THEN** the owning agent's log MUST show a corresponding `NXPTY interact binary -> pty.write()` entry for that session
- **AND** it MUST NOT show a `NXPTY interact binary DROPPED` entry for that keystroke

### Requirement: nexus-ios SHALL receive APNS push notifications

The app SHALL register for APNS push notifications via a real agent-side `/apns/register` endpoint. When the agent fires a `NotificationFired` event for a session whose app is not running/backgrounded, the agent SHALL dispatch an APNS push via HTTP/2 to the device. Tapping the push SHALL deep-link to the session detail. Local notifications already cover the running/backgrounded case; this requirement governs app-killed delivery only.

#### Scenario: push notification received and tappable
- **GIVEN** the iOS app is installed, signed in, APNS provisioned
- **WHEN** the agent fires NotificationFired for session `oo-7f3a`
- **THEN** within 2s the iPhone shows the push; tapping opens the `oo-7f3a` detail scene

#### Scenario: agent-side dispatch path actually exists (nx-q2u0d gap closure)
- **GIVEN** `ApnsRegistrar.swift` POSTs a device token to `{endpoint}/apns/register`
- **WHEN** that request is made
- **THEN** the agent responds with a non-404 success, storing the device token
- **AND** a subsequent `NotificationFired` event for a killed-app session results in an actual
  APNS HTTP/2 send from the agent, not a silent no-op

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

### Requirement: iOS HealthKit read and push to homelab mx-health ingest

The nexus-ios target SHALL read resting HR / HR / HRV via `HKAnchoredObjectQuery` with a
persisted incremental anchor, register `HKObserverQuery` + background delivery for
push-on-change, and POST the Health Auto Export JSON shape directly to the homelab mx-health
ingest endpoint (`http://homelab:8796/ingest`) over the tailnet — not routed through the nexus
agent. This is the production producer for `mx-sqd`/`mx-4d0` (mx repo), replacing the Health
Auto Export stopgap, and is distinct from nx's existing "health" (system metrics,
HealthSummaryScene/HealthCollector).

#### Scenario: HealthKit sample triggers a push to mx-health ingest

- **GIVEN** the user has granted HealthKit read authorization
- **AND** a new resting-HR sample is written by the Health app
- **WHEN** the registered `HKObserverQuery` background-delivery callback fires
- **THEN** the incremental `HKAnchoredObjectQuery` anchor advances past the new sample
- **AND** a POST in the Health Auto Export JSON shape is sent to
  `http://homelab:8796/ingest` over the tailnet

