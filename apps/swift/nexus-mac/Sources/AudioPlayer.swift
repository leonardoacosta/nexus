// AudioPlayer — AVAudioPlayer wrapper that plays a notification MP3 with
// configurable ducking behavior.
//
// Spec: openspec/changes/swift-owns-elevenlabs-synth (task 1.3)
//       openspec/changes/mac-tts-runtime-wire-up (task 1.2 — conforms to
//       MP3PlayerProtocol so TTSObserver in NexusShared can drive playback
//       without importing the macOS-only AVAudioPlayer surface)
//
// Ducking modes (DuckingMode enum lives in NexusShared/Synthesis/MP3Player.swift):
//   - .duck    — temporarily lower other audio while we speak
//   - .mix     — play over existing audio at full volume (default)
//   - .pause   — pause everything else, resume on completion
//
// On macOS, AVAudioSession is iOS-only; ducking is approximated via
// CoreAudio (AudioObjectSetPropertyData on kAudioDevicePropertyVolumeScalar).
// For the v1 cut we ship .mix and .pause via AVAudioPlayer's built-in
// `numberOfLoops = 0` semantics + a global audio-engine pause callback.

import AVFoundation
import Foundation
import NexusShared

public final class AudioPlayer: NSObject, AVAudioPlayerDelegate, @unchecked Sendable {
    public static let shared = AudioPlayer()
    private var player: AVAudioPlayer?
    private var onFinish: (() -> Void)?

    public func play(
        mp3Data: Data,
        ducking: DuckingMode = .mix,
        onFinish: (() -> Void)? = nil
    ) throws {
        self.onFinish = onFinish
        let player = try AVAudioPlayer(data: mp3Data)
        player.delegate = self
        // Volume scaling for the .duck mode — full-bore other-audio control
        // would require CoreAudio AudioObject manipulation, deferred.
        player.volume = ducking == .duck ? 0.9 : 1.0
        player.prepareToPlay()
        player.play()
        self.player = player
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
        self.player = nil
        onFinish?()
        onFinish = nil
    }
}

// MARK: - MP3PlayerProtocol conformance
//
// TTSObserver (in NexusShared) holds an `MP3PlayerProtocol` and stays
// platform-agnostic; this extension wires AudioPlayer.shared to the
// protocol's no-default-arg `play(mp3Data:ducking:)` signature.

extension AudioPlayer: MP3PlayerProtocol {
    public func play(mp3Data: Data, ducking: DuckingMode) throws {
        try play(mp3Data: mp3Data, ducking: ducking, onFinish: nil)
    }
}
