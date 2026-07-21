// KokoroClientTests — request body/URL shape golden test.
//
// Spec: openspec/changes/swift-tts-provider-chain (task 1.5)
//
// Drives KokoroClient through a real URLSession wired to a stubbed
// URLProtocol so the assertions exercise the actual URLRequest KokoroClient
// builds (method, path, headers, timeout, JSON body) rather than a
// hand-reimplemented shadow of it.

import XCTest
@testable import NexusShared

final class KokoroClientTests: XCTestCase {

    // MARK: - Stub transport

    /// Captures the last request (and its body, reconstructed from
    /// `httpBodyStream` when `httpBody` itself has already been converted to
    /// a stream by URLSession) and returns a canned response.
    private final class RecordingURLProtocol: URLProtocol {
        nonisolated(unsafe) static var lastRequest: URLRequest?
        nonisolated(unsafe) static var lastBody: Data?
        nonisolated(unsafe) static var responseData = Data(repeating: 0xAB, count: 2000)
        nonisolated(unsafe) static var statusCode = 200

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            Self.lastRequest = request
            Self.lastBody = request.httpBody ?? Self.readBody(from: request.httpBodyStream)

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: Self.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.responseData)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}

        private static func readBody(from stream: InputStream?) -> Data? {
            guard let stream else { return nil }
            stream.open()
            defer { stream.close() }
            var data = Data()
            let bufferSize = 4096
            var buffer = [UInt8](repeating: 0, count: bufferSize)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: bufferSize)
                guard read > 0 else { break }
                data.append(buffer, count: read)
            }
            return data
        }
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeSettings(baseUrl: String?) -> SettingsStore {
        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "kokoro-client-tests-\(UUID().uuidString)"
        )!)
        store.kokoroBaseUrl = baseUrl
        return store
    }

    override func setUp() {
        super.setUp()
        RecordingURLProtocol.lastRequest = nil
        RecordingURLProtocol.lastBody = nil
        RecordingURLProtocol.responseData = Data(repeating: 0xAB, count: 2000)
        RecordingURLProtocol.statusCode = 200
    }

    // MARK: - Golden request shape

    func testRequestShapeMatchesKokoroContract() async throws {
        let settings = makeSettings(baseUrl: "http://homelab:8880")
        let client = KokoroClient(session: makeSession(), settings: settings)

        let data = try await client.synthesize(text: "hello world", voice: "af_heart")
        XCTAssertEqual(data, RecordingURLProtocol.responseData)

        let request = try XCTUnwrap(RecordingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://homelab:8880/v1/audio/speech")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "audio/mpeg")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "kokoro is Tailscale-only — no auth header")
        XCTAssertEqual(request.timeoutInterval, 8, "8s timeout per the mac-tts-listener spec")

        let bodyData = try XCTUnwrap(RecordingURLProtocol.lastBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "kokoro")
        XCTAssertEqual(json["input"] as? String, "hello world")
        XCTAssertEqual(json["voice"] as? String, "af_heart")
        XCTAssertEqual(json["response_format"] as? String, "mp3")
    }

    // MARK: - notConfigured

    func testEmptyBaseUrlThrowsNotConfigured() async {
        let settings = makeSettings(baseUrl: nil)
        let client = KokoroClient(session: makeSession(), settings: settings)

        do {
            _ = try await client.synthesize(text: "hi", voice: "af_heart")
            XCTFail("expected SpeechProviderError.notConfigured to throw")
        } catch let error as SpeechProviderError {
            guard case .notConfigured = error else {
                XCTFail("expected .notConfigured, got \(error)")
                return
            }
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
        XCTAssertNil(RecordingURLProtocol.lastRequest, "no HTTP request should be made when unconfigured")
    }

    // MARK: - non-200 -> .http(status, snippet)

    func testNon200ThrowsHttpErrorWithSnippet() async {
        RecordingURLProtocol.statusCode = 503
        RecordingURLProtocol.responseData = Data("server overloaded".utf8)

        let settings = makeSettings(baseUrl: "http://homelab:8880")
        let client = KokoroClient(session: makeSession(), settings: settings)

        do {
            _ = try await client.synthesize(text: "hi", voice: "af_heart")
            XCTFail("expected SpeechProviderError.http to throw")
        } catch let error as SpeechProviderError {
            guard case .http(let status, let snippet) = error else {
                XCTFail("expected .http, got \(error)")
                return
            }
            XCTAssertEqual(status, 503)
            XCTAssertEqual(snippet, "server overloaded")
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }
}
