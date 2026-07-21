// SpeechProvider — shared synthesis contract for the TTS provider chain.
//
// Spec: openspec/changes/swift-tts-provider-chain (task 1.1)
//
// TTSObserver walks an ordered chain of SpeechProvider conformers (Kokoro,
// then ElevenLabs) before falling back to AVSpeechSynthesizer. Every
// conformer returns raw MP3 bytes so the existing Data-in -> MP3PlayerProtocol
// -out contract (ducking, AirPods cancel, banner ordering) is untouched —
// only the synthesis step becomes pluggable.

import Foundation

public protocol SpeechProvider: Sendable {
    /// Synthesize `text` in `voice` and return MP3 bytes. Throws on any
    /// failure (missing configuration, HTTP error, network failure,
    /// decoding failure) — the caller (TTSObserver) treats every throw as
    /// "advance to the next provider in the chain".
    func synthesize(text: String, voice: String) async throws -> Data
}

/// Mirrors `ElevenLabsError`'s cases so every SpeechProvider conformer
/// reports failures through the same shape.
public enum SpeechProviderError: Error {
    case notConfigured
    case http(Int, String)
    case decoding
}
