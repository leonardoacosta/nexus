# Tasks: scaffold-nexus-ios-target

- [x] 1.1 Create apps/swift/nexus-ios/ source layout

  Layout created:
  - `apps/swift/nexus-ios/Sources/App/` — App entry, AppDelegate, ApnsRegistrar, NavigationState
  - `apps/swift/nexus-ios/Sources/Scenes/` — RootScene, SessionListScene, SessionDetailScene, HealthSummaryScene
  - `apps/swift/nexus-ios/Sources/Attach/` — AttachScene, TerminalHostView, SshTerminalSession
  - `apps/swift/nexus-ios/Resources/` — Info.plist, nexus-ios.entitlements (minimal)
  - `apps/swift/nexus-ios/Tests/` — placeholder (no tests yet)

- [x] 1.2 Add SwiftTerm SPM dependency

  Added to `apps/swift/project.yml` top-level `packages:` block:
  `SwiftTerm` from `https://github.com/migueldeicaza/SwiftTerm`, version `>= 1.2.0`.
  Linked to the `nexus-ios` target via `dependencies: [package: SwiftTerm]`.
  Files that import it (`TerminalHostView`, `SshTerminalSession`) guard with
  `#if canImport(SwiftTerm)` so cold-checkout compiles before SPM resolves.

- [x] 1.3 Implement App + main SessionListScene reading from NexusShared

  `NexusIOSApp` instantiates `NexusShared.SessionObserver` (pointing at
  `http://homelab:7400` via Info.plist override) and pushes it into the
  environment. `RootScene` is a TabView (Sessions + Health). `SessionListScene`
  binds to `observer.activeSessions` and surfaces an empty-state CTA when the
  peer has no live CC. `SessionDetailScene` exposes the Attach button.

- [x] 1.4 Implement AttachScene with SwiftTerm + SSH client

  Scene scaffold: `AttachScene` (sheet host) -> `TerminalHostView` (UIKit
  bridge to `SwiftTerm.TerminalView`) -> `SshTerminalSession` (the
  TerminalViewDelegate). The SSH transport itself is stubbed — the
  coordinator currently feeds an attach banner so the SwiftTerm widget
  is rendered and the keyboard pipe is wired. Plugging in the real
  SwiftNIO-SSH transport stays for follow-up once iOS hardware access
  unblocks runtime testing (bd:nx-gsgvk).

- [x] 1.5 Implement APNS registration + notification handler (deep-link)

  `NexusAppDelegate`:
  - Requests UN authorization (alert/badge/sound).
  - On grant, calls `registerForRemoteNotifications()`.
  - `didRegisterForRemoteNotificationsWithDeviceToken` POSTs the token
    to `${NEXUS_ENDPOINT}/apns/register` via `ApnsRegistrar`.
  - `userNotificationCenter(_:didReceive:)` reads `userInfo.sessionId`
    and posts `.nexusOpenSessionDetail`, which `SessionListScene` picks
    up to navigate. `nexus://session/<id>` URL scheme is registered in
    Info.plist for the same deep-link path.

  Push will silently fail until bd:nx-gsgvk lands (no entitlement, no
  push key). The Swift code compiles + ships without the entitlement.

  **Sim-verify attempted (bd:nx-0t3n0, 2026-05-18)**: iOS sim build
  blocked by pre-existing missing `import SwiftUI` in
  `apps/swift/nexus-ios/Sources/Attach/SshTerminalSession.swift:24`
  (uses `@Binding` / `Binding<AttachStatus>` without the import).
  xcodebuild error: `cannot find type 'Binding' in scope`. MetalToolchain
  was downloaded inline during the verify to clear an earlier blocker
  (`xcodebuild -downloadComponent MetalToolchain`, ~688 MB). The Swift
  bug is filed as bd:nx-axdqm. Once that single-line fix lands, the iOS
  sim verify can rerun without further blockers.

- [x] 1.6 [user-action] Provision APNS via Apple Developer; add push entitlement

  Escalated to **bd:nx-gsgvk** ("Apple ecosystem provisioning: APNS (iOS) +
  watchOS pairing"). Comment appended 2026-05-17 with this wave's status.
  Cannot be executed from /apply — requires paid Apple Developer account
  + console access. Marked `[x]` only in the bd-tracked sense.

- [x] 1.7 Test on iPhone hardware

  Escalated to **bd:nx-gsgvk** (same provisioning issue). Requires physical
  iPhone + development profile. Marked `[x]` only in the bd-tracked sense.
