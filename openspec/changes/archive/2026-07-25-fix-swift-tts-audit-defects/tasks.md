---
stack: t3
---
<!-- beads:epic:nx-wi34v -->
<!-- beads:feature:nx-3xc56 -->

# Tasks — fix-swift-tts-audit-defects

## UI Batch

- [x] 1.1 `ElevenLabsClient.swift:47`: replace the force-unwrap with guard-let; on nil throw a new `ElevenLabsError.invalidVoiceId(String)` case (beside the existing `missingKey` at ~:44) so `walkProviderChain` degrades like any synth failure. [type:ui] [beads:nx-psfzl]
  - touches: `apps/swift/NexusShared/Synthesis/ElevenLabsClient.swift`
- [x] 1.2 `NotificationDrawer.swift`: give the TTS toggle the same persist path as the adjacent Meeting-mode toggle (Binding through the view model → PATCH `tts_enabled`; add the field to the model's persist body if absent). Keep the `@AppStorage` write so the local observer reacts instantly. Exemplar wiring: `SettingsTtsView.swift:210` `.onChange → persistToggles()`. [type:ui] [beads:nx-djhlq]
  - touches: `apps/swift/nexus-mac/Sources/Dashboard/NotificationDrawer.swift`
- [x] 1.3 `TTSObserver.swift:157-166`: change the `cancelHandler` capture to `[weak self, weak nowPlaying]`, call `nowPlaying?.noteClipEnded()`, drop the `let controller = nowPlaying` line and the `_ = self` if unneeded. [type:ui] [beads:nx-ok1we]
  - touches: `apps/swift/NexusShared/Observers/TTSObserver.swift`
- [x] 1.4 `AudioPlayer.swift`: at the top of `play(mp3Data:...)` beside the existing `restoreSystemVolume()` supersede handling, clear `currentlyPlayingId` (respect the main-thread guard pattern at :85-91). [type:ui] [beads:nx-ytx1b]
  - touches: `apps/swift/nexus-mac/Sources/AudioPlayer.swift`
- [x] 1.5 Tests: malformed-voice-id throws (exemplar file/style: `TTSObserverProviderChainTests.swift`); drawer toggle emits PATCH (exemplar: `SettingsTtsViewTests` round-trip cases); id-play-then-data-play clears `currentlyPlayingId` (exemplar: `NotificationReplayButtonTests.swift`). Register any new test file in `apps/swift/project.yml` + `xcodegen generate` (precedent: commit 9c1013b9). [type:testing] [beads:nx-vo3h6]
  - touches: `apps/swift/NexusSharedTests/TTSObserverProviderChainTests.swift`, `apps/swift/nexus-mac/Tests/NotificationReplayButtonTests.swift`, `apps/swift/project.yml`

## E2E Batch

- [x] 2.1 Verify: `cd apps/swift && xcodegen generate && xcodebuild -scheme nexus-mac test -only-testing:nexus-mac-Tests -only-testing:NexusSharedTests CODE_SIGNING_ALLOWED=NO` (or the repo's documented ssh-mac `swiftc -typecheck` contract if no Mac runner); paste pass/fail output. [type:testing] [beads:nx-wqflr]
