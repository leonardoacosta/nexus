---
stack: t3
---
<!-- beads:epic:nx-wi34v -->
<!-- beads:feature:nx-qozlp -->

# Tasks — tts-pipeline-stop-and-queue

## UI Batch

- [x] 1.1 [user] DECISION: back-to-back `tts` event policy — queue-and-play-sequentially, or drop-and-log the second when one is already in flight? searched: `TTSObserver.handle()`, `AudioPlayer.swift`, `MP3Player.swift` — no existing queue/drop primitive anywhere in the pipeline; this is a genuine new architectural choice, not a documented pattern being missed. [type:config] [beads:nx-3l0c3]
  - Option 1: Queue-and-play-sequentially — every `tts` event eventually plays, in arrival order; simplest mental model, but a burst of N notifications means N clips play back-to-back with no user control to skip ahead other than the new stop button.
  - Option 2: Drop-and-log the second — only the newest pending event survives when one is already in flight; each notification still gets `postBanner()`'s visual/desktop delivery, but a lower-priority in-flight clip can lose its audio to a later one. Matches `MP3Player.swift`'s existing "most-recent notification wins" doc comment.
  - **Decision (by:leo): Option 1 — Queue-and-play-sequentially.**
- [x] 1.2 Give pipeline playback a "currently playing" identity: either pass the event id into `playMP3()` -> `AudioPlayer.play()` and reuse `setCurrentlyPlaying(id:)`, or add a new dedicated published property if reusing the replay-button field creates cross-talk between a live pipeline clip and a manual replay tap. [type:ui] [beads:nx-8jx34]
  - touches: `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/nexus-mac/Sources/AudioPlayer.swift`
- [x] 1.3 Implement the queue/drop policy chosen in 1.1 in `TTSObserver.handle()`/`synthesise()`. [type:ui] [beads:nx-cc3u3]
  - touches: `apps/swift/NexusShared/Observers/TTSObserver.swift`
- [x] 1.4 Confirm `NotificationReplayButton`'s existing `isPlaying`/tap-to-stop logic needs no change beyond whatever id-plumbing 1.2 introduces — it already reads `currentlyPlayingId` generically. [type:ui] [beads:nx-r58rk]
  - touches: `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift`

## E2E Batch

- [x] 2.1 New `AudioControlTests.swift` case: a row matching the currently pipeline-playing event id renders `stop.circle`; tapping it halts audio with no new clip starting. [type:testing] [beads:nx-j5fws]
  - touches: `apps/swift/nexus-mac/Tests/AudioControlTests.swift`
- [x] 2.2 New `TTSObserverTests.swift` case covering the 1.1 policy: two `tts` events delivered back-to-back produce the chosen behavior (sequential play, or drop-and-log) — not an uncoordinated race. [type:testing] [beads:nx-m3du3]
  - touches: `apps/swift/nexus-mac/Tests/TTSObserverTests.swift`
- [x] 2.3 Verify: `xcodebuild -scheme nexus-mac test -only-testing:nexus-mac-Tests -only-testing:NexusSharedTests` green (or the ssh-mac `swiftc -typecheck` contract) — paste output. [type:testing] [beads:nx-yl248]
