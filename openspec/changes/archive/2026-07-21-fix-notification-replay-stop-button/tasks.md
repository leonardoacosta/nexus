---
stack: t3
---
<!-- beads:epic:nx-pznqx -->
<!-- beads:feature:nx-vfmbw -->

# Implementation Tasks

## UI Batch

- [x] [1.1] In `apps/swift/nexus-mac/Sources/AudioPlayer.swift`, add a `@Published private(set) var currentlyPlayingId: String?` (or equivalent observable identifier) that is set when playback starts and cleared to `nil` both when `stop()` is called and when playback finishes naturally (hook the existing finish-callback path, e.g. `onFinish`/`onPlaybackFinished`). In `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift`: remove `.disabled(isPlaying)` (line ~37); replace the local `isPlaying` `@State` with an observation of `AudioPlayer.shared.currentlyPlayingId == notification.id`; on tap — if this row is the currently-playing one, call `AudioPlayer.shared.stop()`; otherwise call `AudioPlayer.shared.stop()` first (interrupts any other row) then start this row's playback via the existing fetch+`play(mp3Data:ducking:)` path. Remove the `defer { isPlaying = false }` that fires immediately after the async `play()` call returns — the button's icon state now derives from `currentlyPlayingId`, which only clears on real stop/finish. [beads:nx-6ea5m]
- [x] [1.2] Add/extend Swift unit tests (or an XCTest/Swift Testing target already covering `AudioPlayer`/`NotificationReplayButton` if one exists — search first) asserting: (a) tapping a row's button while it's the currently-playing row calls `stop()` and clears `currentlyPlayingId`; (b) tapping a different row while another is playing stops the current one first, then starts the new row's playback, updating `currentlyPlayingId` to the new row's id; (c) `currentlyPlayingId` clears automatically when the finish callback fires without an explicit stop tap. [beads:nx-0j0g0]
  - depends on: 1.1
- [x] [1.3] Typecheck gate: from Linux, run the headless Mac typecheck (`ssh mac` + `swiftc -typecheck` over `apps/swift/nexus-mac` sources per the swift-engineer contract) and paste passing output; zero errors. [beads:nx-kg70u]
  - depends on: 1.1, 1.2

## User Gate

- [ ] [2.1] [user:post] On-device verification on the Mac (GUI + audio-bound): open the notification drawer, tap a row's replay button, confirm audio starts and the icon shows stop; tap the same row's button again mid-playback and confirm audio stops immediately and the icon reverts to play; start playback on one row then tap a different row's button and confirm the first stops while the second starts; let a replay finish naturally and confirm the icon reverts to play without any tap. searched: nx open beads + swift-menubar-client archived specs for an existing audio-playback UI verification checklist; none covers this drawer's play/stop toggle specifically — new manual step required (SwiftUI button interaction + real audio playback cannot be exercised headlessly from Linux). [beads:nx-nhiu7]
  - depends on: 1.1, 1.2, 1.3
