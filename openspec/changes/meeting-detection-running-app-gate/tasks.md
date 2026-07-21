---
stack: t3
---
<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-fd96s -->

# Tasks — meeting-detection-running-app-gate

## UI Batch

- [ ] 1.1 In `apps/swift/NexusShared/Observers/PresenceObserver.swift`, add a `runningBundleIds: Set<String>` field to `RawSignals` (default `[]`), and change `PresenceSensing.isMeeting(_:)` to check `s.cameraInUse || s.micInUse` AND `!s.runningBundleIds.isDisjoint(with: meetingBundleIds)` instead of the current `frontmostBundleId` check. Remove the now-unused `frontmostBundleId` field from `RawSignals`, its initializer parameter, and the `Self.frontmostBundleId()` live collector function (grep confirmed no other callers). Update the live `RawSignals` construction site to populate `runningBundleIds` from `NSWorkspace.shared.runningApplications.compactMap { $0.bundleIdentifier }` instead. [type:ui] [beads:nx-tnkzd]
  - touches: `apps/swift/NexusShared/Observers/PresenceObserver.swift`
- [ ] 1.2 Update `apps/swift/NexusSharedTests/PresenceObserverTests.swift`: replace every `frontmostBundleId:` argument in existing `RawSignals(...)` test fixtures with the equivalent `runningBundleIds:` set, and add new scenarios covering the delta's five spec scenarios — meeting-app-running-but-not-frontmost still sets `inMeeting: true`; meeting app not running (even if previously frontmost) does not; meeting app running but no camera/mic in use does not; meeting ending (app quits or devices idle) flips `inMeeting` back to `false` on the next diffed delta. [type:testing] [beads:nx-5wkse]
  - touches: `apps/swift/NexusSharedTests/PresenceObserverTests.swift`
- [ ] 1.3 Verify: run `xcodebuild -scheme NexusShared -destination 'platform=macOS' test -only-testing:NexusSharedTests/PresenceObserverTests` (or the repo's documented Linux->Mac headless typecheck contract — `ssh mac` + `swiftc -typecheck` — if a live macOS test runner isn't available in this session) and paste the pass/fail output before marking this batch complete. [type:testing] [beads:nx-h1o1q]
