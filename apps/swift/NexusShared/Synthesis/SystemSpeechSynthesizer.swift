// SystemSpeechSynthesizer — thin AVSpeechSynthesizer wrapper used as the
// fallback synthesis path when ElevenLabs is unavailable.
//
// Spec: openspec/changes/mac-tts-runtime-wire-up (task 1.1)
//
// NOT a singleton (AVSpeechSynthesizer owns its own delegate lifecycle and
// internal queue — multiple instances are safe and the OS coalesces audio
// routing). Plays directly via the OS speech audio path; does NOT pipe
// through AudioPlayer. Ducking is a no-op on macOS (AVAudioSession is
// iOS-only) and best-effort on iOS via the system audio session.
//
// Cross-platform: AVSpeechSynthesizer is available on macOS 10.14+,
// iOS 7+, and watchOS 7+ — no platform guards needed.

import AVFoundation
import Foundation

@MainActor
public final class SystemSpeechSynthesizer {
    private let synth = AVSpeechSynthesizer()

    public init() {}

    /// Enqueue an utterance for immediate playback. AVSpeechSynthesizer
    /// queues internally — multiple calls in succession play in order.
    public func speak(_ text: String, rate: Float = AVSpeechUtteranceDefaultSpeechRate) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        synth.speak(utterance)
    }
}
