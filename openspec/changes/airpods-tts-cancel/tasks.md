<!-- beads:epic:nx-ga815 -->
<!-- beads:feature:nx-zhwst -->

# Tasks

## DB Batch

(none — Swift client feature, no schema)

## API Batch

(none — no agent/HTTP changes)

## UI Batch

- [x] Add `stop()` to `MP3PlayerProtocol` in `apps/swift/NexusShared/Synthesis/MP3Player.swift` and implement it in the concrete player (`AVAudioPlayer.stop()`; reset for next play). Safe no-op when idle.
- [x] Make the `AVSpeechSynthesizer` fallback cancellable in `TTSObserver` — hold a reference to the synthesizer and call `stopSpeaking(at: .immediate)` on cancel. (This app replaced AVSpeechSynthesizer with a `/usr/bin/say` subprocess queue; `SystemSpeechSynthesizer.stop()` terminates the live subprocess — the immediate-stop analogue.)
- [x] Create `apps/swift/NexusShared/Observers/NowPlayingController.swift` — acquires `MPNowPlayingInfoCenter` session on TTS start, resigns after playback end + 2s grace, resets grace on a new clip. Exposes `acquire()`, `noteClipEnded()`, and a `cancelHandler` hook.
- [x] Register `MPRemoteCommandCenter` `togglePlayPause`/`play`/`pause` handlers in `NowPlayingController`; on fire, invoke the cancel hook + return `.success` (consume).
- [x] Wire `TTSObserver` to call `NowPlayingController.acquire()` before playback (Stage 2/3) and `noteClipEnded()` after playback completes; route the cancel hook to stop the `MP3Player` + speech-synth.
- [x] Regenerate the Xcode project if a new file was added (`cd apps/swift && xcodegen generate`).

## E2E Batch

- [x] Add `apps/swift/nexus-mac/Tests/AudioControlTests.swift` (host-bundled test target; same placement rationale as TTSObserverTests) asserting: `MP3Player.stop()` is recorded via the protocol surface + `AudioPlayer.stop()` is a no-op when idle; `NowPlayingController` acquires on start and resigns only after the grace window (injected short grace); grace resets on a new clip; the toggle handler invokes the cancel hook.
- [ ] Manual verification (operator): play a TTS notification, single-press AirPods mid-clip, confirm it stops immediately; confirm media keys return to the music app ~2s after a clip ends. Build + relaunch Nexus.app via `deploy/install.sh`.
