# Change: airpods-tts-cancel

## Why

When a TTS notification is playing (especially a long one), there is no fast way to dismiss it — the user must wait it out. AirPods (and any media remote) expose a play/pause button that the system can route to the foreground "Now Playing" app. By owning the Now Playing session for the duration of TTS playback plus a short grace window, the Mac dashboard can intercept a single play/pause press and cancel the in-flight TTS immediately. This is the foundation for richer AirPods-driven audio control (voice commands land in a follow-up, `airpods-stt-command`, which reuses this Now-Playing window).

## What Changes

- Add a `stop()` method to `MP3PlayerProtocol` (and its concrete player) so in-flight synthesized audio can be cancelled; cancel the `AVSpeechSynthesizer` fallback via `stopSpeaking(at:)`.
- Add a `NowPlayingController` in NexusShared that acquires the system Now-Playing session (`MPNowPlayingInfoCenter`) when TTS playback starts and resigns it after playback ends plus a 2-second grace window.
- Register an `MPRemoteCommandCenter.togglePlayPauseCommand` handler that, while TTS is playing, cancels the in-flight TTS (audio + speech-synth) and consumes the command.
- Wire `TTSObserver` to drive the NowPlayingController lifecycle and route the play/pause command to cancellation.

## Context

- depends on: (none)
- touches: `apps/swift/NexusShared/Synthesis/MP3Player.swift`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/NexusShared/Observers/NowPlayingController.swift`, `apps/swift/nexus/nexusUITests/AudioControlTests.swift`

## Impact

- **Capability:** mac-tts-listener
- **Breaking:** No — additive. Existing TTS playback is unchanged when no remote command fires.
- **Permissions:** None new. `MPRemoteCommandCenter` / `MPNowPlayingInfoCenter` require no TCC prompt.
- **Trade-off:** While the app owns the Now-Playing session (TTS playback + 2s grace), AirPods/media keys control the TTS rather than the user's music app. The window is bounded to the TTS clip length + 2s, then media keys return to the prior Now-Playing app.
- **Files changed:** ~3 Swift + 1 UI test. Mac-only (NexusShared is shared, but the remote-command surface is macOS-targeted).
- **Foundation for:** `airpods-stt-command` (reuses the Now-Playing window + grace).
