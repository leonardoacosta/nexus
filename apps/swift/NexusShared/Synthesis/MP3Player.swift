// MP3Player — protocol surface for MP3 playback shared across Apple targets.
//
// Spec: openspec/changes/mac-tts-runtime-wire-up (task 1.2 — TTSObserver
// dependency seam)
//
// Why this exists: NexusShared is cross-platform (macOS / iOS / watchOS)
// but AVAudioPlayer-backed AudioPlayer lives in the macOS-only nexus-mac
// target. TTSObserver lives in NexusShared and must speak to playback via
// a protocol so per-platform conformers (nexus-mac AudioPlayer, future
// nexus-ios player) plug in without NexusShared importing macOS-only code.
//
// DuckingMode also moved here from nexus-mac/Sources/AudioPlayer.swift so
// SettingsStore + TTSObserver can read/write the value without an
// inverse-direction dependency.

import Foundation

/// Audio mixing behaviour for notification MP3 playback. macOS implements
/// only `.mix` (full volume) and a soft `.duck` (90% volume) in the v1
/// AudioPlayer; `.pause` and platform-native ducking are deferred.
public enum DuckingMode: String, Codable, Sendable, CaseIterable {
    case duck
    case mix
    case pause
}

/// Playback surface for synthesised speech audio. Conformers MUST be
/// idempotent — repeated calls overwrite the in-flight player (most-recent
/// notification wins). Throwing is reserved for malformed MP3 data;
/// device-level failures are logged by the conformer.
public protocol MP3PlayerProtocol: AnyObject, Sendable {
    func play(mp3Data: Data, ducking: DuckingMode) throws

    /// Halt the in-flight clip immediately, leaving the player ready for the
    /// next `play()`. MUST be a safe no-op when nothing is playing.
    ///
    /// Spec: openspec/changes/airpods-tts-cancel (mac-tts-listener,
    /// "In-flight TTS playback MUST be cancellable"). A single AirPods
    /// play/pause press routes through `NowPlayingController.cancelHandler`
    /// to this method.
    func stop()

    /// Invoked when a clip finishes playing on its own (NOT when `stop()`
    /// cancels it). TTSObserver wires this to `NowPlayingController.noteClipEnded()`
    /// so the Now-Playing grace window starts only after a natural finish.
    /// Optional — conformers that don't surface a finish signal leave the
    /// default no-op getter/setter (the grace window then relies on the
    /// system-speech `waitForIdle()` path or never starts, which is harmless:
    /// the controller resigns on the next clip's acquire).
    var onPlaybackFinished: (() -> Void)? { get set }
}

public extension MP3PlayerProtocol {
    /// Default no-op so existing conformers (test spies, SettingsTtsView
    /// preview players) don't have to implement the finish seam.
    var onPlaybackFinished: (() -> Void)? {
        get { nil }
        set { _ = newValue }
    }
}
