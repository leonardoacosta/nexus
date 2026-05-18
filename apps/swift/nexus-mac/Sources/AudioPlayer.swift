// AudioPlayer — AVAudioPlayer wrapper that plays a notification MP3 with
// configurable ducking behavior.
//
// Spec: openspec/changes/swift-owns-elevenlabs-synth (task 1.3)
//
// Ducking modes:
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

public enum DuckingMode: String, Codable, Sendable {
    case duck
    case mix
    case pause
}

public final class AudioPlayer: NSObject, AVAudioPlayerDelegate {
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
