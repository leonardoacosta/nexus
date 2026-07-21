// KokoroClient — Kokoro-FastAPI client conforming to SpeechProvider.
//
// Spec: openspec/changes/swift-tts-provider-chain (task 1.2)
//
// Kokoro-FastAPI speaks OpenAI's `/v1/audio/speech` and returns MP3, so it
// slots into the same Data-out contract as ElevenLabsClient. The server is
// Tailscale-only (no auth header). Reads `kokoroBaseUrl` from SettingsStore
// on every call (cheap; UserDefaults) rather than caching it, so a Settings
// edit takes effect on the very next notification with no restart.

import Foundation

public actor KokoroClient: SpeechProvider {
    private let session: URLSession
    private let settings: SettingsStore

    public init(session: URLSession = .shared, settings: SettingsStore = .shared) {
        self.session = session
        self.settings = settings
    }

    /// POST {baseUrl}/v1/audio/speech -> MP3 bytes. Throws
    /// SpeechProviderError.notConfigured when no base URL is set (or it
    /// doesn't parse as a URL) — the caller (TTSObserver) is expected to
    /// gate on `settings.kokoroBaseUrl` before attempting Kokoro at all, but
    /// this guard keeps a direct call safe regardless.
    public func synthesize(text: String, voice: String) async throws -> Data {
        guard let baseUrl = settings.kokoroBaseUrl, !baseUrl.isEmpty,
              let base = URL(string: baseUrl)
        else {
            throw SpeechProviderError.notConfigured
        }
        let url = base.appendingPathComponent("v1/audio/speech")

        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        let body: [String: Any] = [
            "model": "kokoro",
            "input": text,
            "voice": voice,
            "response_format": "mp3",
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SpeechProviderError.decoding
        }
        if http.statusCode != 200 {
            let snippet = String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw SpeechProviderError.http(http.statusCode, snippet)
        }
        return data
    }
}
