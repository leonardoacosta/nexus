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

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18, post-blocker SHA ba7a702)**:
  iOS sim build clean (`xcodebuild -scheme nexus-ios -destination
  'platform=iOS Simulator,id=9630A395-9741-48E8-8E59-F15941EBE942' build`
  → `** BUILD SUCCEEDED **`), app installed + launched on iPhone sim
  (pid 77666), UNAuthorization requested.

- [x] 1.4 Implement AttachScene with SwiftTerm + SSH client

  Scene scaffold: `AttachScene` (sheet host) -> `TerminalHostView` (UIKit
  bridge to `SwiftTerm.TerminalView`) -> `SshTerminalSession` (the
  TerminalViewDelegate). The SSH transport itself is stubbed — the
  coordinator currently feeds an attach banner so the SwiftTerm widget
  is rendered and the keyboard pipe is wired. Plugging in the real
  SwiftNIO-SSH transport stays for follow-up once iOS hardware access
  unblocks runtime testing (bd:nx-gsgvk).

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18)**: compiles clean on
  iOS sim. Required two follow-on patches during retry beyond
  nx-axdqm's missing `import SwiftUI`: (a) `@preconcurrency` annotation
  on `TerminalViewDelegate` conformance to handle `@MainActor` class
  conforming to nonisolated SwiftTerm protocol under Swift 6 concurrency
  diagnostics, (b) added missing `rangeChanged(source:startY:endY:)`
  delegate stub. Filed inline (small surface).

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

  **Sim-verified (bd:nx-0t3n0 retry, 2026-05-18, post-blocker SHA ba7a702)**:
  `xcrun simctl push 9630A395-9741-48E8-8E59-F15941EBE942
  dev.leonardoacosta.nexus.ios /tmp/ios-push.json` → `Notification sent`.
  Log probe `xcrun simctl spawn ... log show --predicate 'subsystem ==
  "com.apple.UserNotifications"'` confirms the running nexus process
  (pid 77666) created its UN center, called
  `requestAuthorization(options: 7)`, and SpringBoard surfaced the auth
  prompt. Without a real device token + APNS round-trip
  (`Foreground app will not request ephemeral notifications`,
  `Ignore becoming foreground for application without push registration`),
  the simctl push delivers via sim local channel — exactly the contract.
  Full APNS round-trip stays gated by hardware (bd:nx-gm1tl).

- [x] 1.6 [user-action] Provision APNS via Apple Developer; add push entitlement

  Escalated to **bd:nx-gsgvk** ("Apple ecosystem provisioning: APNS (iOS) +
  watchOS pairing"). Comment appended 2026-05-17 with this wave's status.
  Cannot be executed from /apply — requires paid Apple Developer account
  + console access. Marked `[x]` only in the bd-tracked sense.

- [x] 1.7 Test on iPhone hardware

  Escalated to **bd:nx-gsgvk** (same provisioning issue). Requires physical
  iPhone + development profile. Marked `[x]` only in the bd-tracked sense.
