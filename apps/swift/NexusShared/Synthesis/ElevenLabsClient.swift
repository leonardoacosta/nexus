// ElevenLabsClient — direct ElevenLabs API client used by the Mac listener.
//
// Spec: openspec/changes/swift-owns-elevenlabs-synth (task 1.2)
//
// Reads the API key from Keychain on every call (cheap; Keychain has its
// own cache). Synthesizes a notification line into MP3 bytes and returns
// them — the caller (nexus-mac AVAudioPlayer) handles ducking + playback.

import Foundation

public struct ElevenLabsSynthRequest: Sendable {
    public var text: String
    public var voiceId: String
    public var modelId: String

    public init(text: String, voiceId: String, modelId: String = "eleven_turbo_v2_5") {
        self.text = text
        self.voiceId = voiceId
        self.modelId = modelId
    }
}

public enum ElevenLabsError: Error {
    case missingKey
    /// The voice id could not form a valid request URL (empty, or carrying
    /// characters URL(string:) rejects). Thrown instead of force-unwrapping so
    /// `walkProviderChain` degrades to the next provider like any synth failure.
    case invalidVoiceId(String)
    case http(Int, String)
    case decoding
}

public actor ElevenLabsClient {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// A usable ElevenLabs voice id: non-empty, and free of whitespace and
    /// control characters that would corrupt the request path. `internal` so
    /// NexusSharedTests can assert the contract without a live HTTP call —
    /// the same test-seam convention TTSObserver uses.
    static func isWellFormedVoiceId(_ voiceId: String) -> Bool {
        guard !voiceId.isEmpty else { return false }
        let illegal = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        return voiceId.rangeOfCharacter(from: illegal) == nil
    }

    /// POST /v1/text-to-speech/{voice_id} -> MP3 bytes.
    /// Throws ElevenLabsError.missingKey when the Keychain doesn't have a
    /// configured key (user has not pasted it via Settings yet).
    public func synthesize(_ request: ElevenLabsSynthRequest) async throws -> Data {
        let apiKey: String
        do {
            apiKey = try Keychain.get(KeychainAccount.elevenLabsApiKey)
        } catch KeychainError.notFound {
            throw ElevenLabsError.missingKey
        }

        // A malformed voice id (stale per-project override, a bad paste) used to
        // force-unwrap-crash the whole listener here. Throw instead so the
        // provider chain falls through to the next provider.
        //
        // Both guards are load-bearing: modern Foundation's URL parser is lenient
        // enough to accept spaces and control characters in a path segment (so the
        // nil branch alone never fires on macOS 26), while older/linked-on-older
        // parsers reject them outright. Validating the id explicitly makes the
        // degrade deterministic across both.
        guard Self.isWellFormedVoiceId(request.voiceId) else {
            throw ElevenLabsError.invalidVoiceId(request.voiceId)
        }
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(request.voiceId)") else {
            throw ElevenLabsError.invalidVoiceId(request.voiceId)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        let body: [String: Any] = [
            "text": request.text,
            "model_id": request.modelId,
            "voice_settings": [
                "stability": 0.5,
                "similarity_boost": 0.75,
            ],
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ElevenLabsError.decoding
        }
        if http.statusCode != 200 {
            let snippet = String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw ElevenLabsError.http(http.statusCode, snippet)
        }
        return data
    }
}

// MARK: - SpeechProvider conformance

// Adapter onto the shared provider-chain contract (swift-tts-provider-chain,
// task 1.3). The existing `synthesize(_:)` request path and default model id
// are untouched — this just maps the chain's (text, voice) shape onto it.
extension ElevenLabsClient: SpeechProvider {
    public func synthesize(text: String, voice: String) async throws -> Data {
        try await synthesize(ElevenLabsSynthRequest(text: text, voiceId: voice))
    }
}
