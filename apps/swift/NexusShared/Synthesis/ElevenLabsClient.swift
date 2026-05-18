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
    case http(Int, String)
    case decoding
}

public actor ElevenLabsClient {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
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

        let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(request.voiceId)")!
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
