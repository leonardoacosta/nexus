<!-- beads:epic:nx-ga815 -->
<!-- beads:feature:nx-ebmne -->

# Tasks

## DB Batch

(none — Swift client feature, no schema)

## API Batch

(none — reuses existing `POST /commands/send-text`; no agent changes)

## UI Batch

- [x] Create `apps/swift/NexusShared/Speech/SpeechController.swift` — `SFSpeechRecognizer` + `AVAudioEngine`, `requiresOnDeviceRecognition = true`, lazy mic + speech authorization, `start()`/`stop()` (stop finalizes transcript), graceful failure on denial/unavailable. Guard with `#if canImport(Speech)` / os(macOS) so NexusShared still compiles for watch.
- [x] Extend `NowPlayingController` (from `airpods-tts-cancel`) to register `nextTrackCommand` (double-press → start STT) and route a press-while-recording → stop+send; expose recording state. Keep the existing togglePlayPause→cancel-TTS behavior intact.
- [x] Track last-notified session in `TTSObserver`: capture project + session id from each `NotificationFired`; expose for routing. Wire the NowPlayingController STT start/stop hooks to the SpeechController + transcript routing.
- [x] Route finalized transcript via `NexusClient.sendText` to the tracked session; fall back to a banner when no session resolves.
- [x] Add `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription` to `apps/swift/nexus/nexus/Info.plist`.
- [x] Regenerate Xcode project (`cd apps/swift && xcodegen generate`) for the new file.

## E2E Batch

- [x] Add `apps/swift/nexus-mac/Tests/SttCommandTests.swift` — unit-level: `SpeechController` start/stop finalizes a transcript from a stubbed/injected recognizer; routing sends to the tracked session; no-session falls back to banner; double-press outside the now-playing window does not start recording. (Mic-driven paths mocked since unit tests can't speak.)
- [ ] Manual verification (operator): trigger a TTS notification from session X; double-press AirPods, speak, press again → confirm transcript lands in session X's tmux pane. Confirm a double-press with no recent TTS does NOT start recording. Build + relaunch via `deploy/install.sh`.
