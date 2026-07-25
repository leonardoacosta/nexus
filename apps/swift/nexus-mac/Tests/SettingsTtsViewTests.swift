// SettingsTtsViewTests — persistence parity + keychain round-trip +
// ProjectVoicesView mount smoke.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.12, bd:nx-85e22)

import XCTest
import SwiftUI
@testable import nexus
@testable import NexusShared

/// In-process URLProtocol that records the outgoing request (method + body)
/// for a single PATCH, then answers 200 `{}`. Sandbox-safe (no socket bind) —
/// same pattern as CredentialsViewTests' RespondingURLProtocol, injected via
/// NexusClient's `protocolClasses` test seam. Custom URLProtocols see the
/// request body on `httpBodyStream` (URLSession moves `httpBody` there), so we
/// drain the stream rather than reading `httpBody` (which is nil here).
private final class CapturingURLProtocol: URLProtocol {
    static let lock = NSLock()
    static var capturedMethod: String?
    static var capturedBody: Data?

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        capturedMethod = nil
        capturedBody = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.capturedMethod = request.httpMethod
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            let bufSize = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: bufSize)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            Self.capturedBody = data
        } else {
            Self.capturedBody = request.httpBody
        }
        Self.lock.unlock()

        let resp = HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class SettingsTtsViewTests: XCTestCase {

    // MARK: - [3.4] duckingWire() vocabulary bridge (sync-notification-settings-round-trip)

    /// The Mac's duck/mix/pause DuckingMode maps to the agent's full/half/mute
    /// `ducking_mode` column. A drift here 400s the whole PATCH
    /// (notification-settings.ts DUCKING_MODES rejects any other value), so the
    /// exact triple is load-bearing: mix→full, duck→half, pause→mute.
    func testDuckingWireMapsMacVocabularyToServerVocabulary() {
        XCTAssertEqual(SettingsTtsViewModel.duckingWire(.mix), "full",
                       "mix (no dip) → full")
        XCTAssertEqual(SettingsTtsViewModel.duckingWire(.duck), "half",
                       "duck (~40% dip) → half")
        XCTAssertEqual(SettingsTtsViewModel.duckingWire(.pause), "mute",
                       "pause (~15% near-silence) → mute")
    }

    /// Every DuckingMode case maps to one of the server's three accepted
    /// values — so a future added case can't silently produce an out-of-vocab
    /// string that 400s the PATCH.
    func testDuckingWireOnlyEmitsServerAcceptedValues() {
        let accepted: Set<String> = ["full", "half", "mute"]
        for mode in DuckingMode.allCases {
            XCTAssertTrue(accepted.contains(SettingsTtsViewModel.duckingWire(mode)),
                          "\(mode) must map into the server's DUCKING_MODES vocabulary")
        }
    }

    // MARK: - [3.4] PATCH carries snake_case keys + wire ducking value

    /// The toggle-persist path PATCHes /notifications/settings with snake_case
    /// keys the agent's ALLOWED_KEYS accepts (tts_enabled / banner_enabled /
    /// ducking_mode / signal_only). camelCase keys 400 silently. Drive the same
    /// body persistToggles() builds through the real NexusClient transport (via
    /// the protocolClasses stub) and assert the wire request: PATCH verb,
    /// snake_case keys present, and ducking_mode carrying the bridged value.
    func testPatchNotificationSettingsSendsSnakeCaseKeysAndWireDucking() async throws {
        CapturingURLProtocol.reset()
        let client = NexusShared.NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://agent.test/")!),
            protocolClasses: [CapturingURLProtocol.self]
        )

        // Body shaped exactly like SettingsTtsViewModel.persistToggles(),
        // routing the ducking selection through the production bridge.
        let body: [String: Any] = [
            "tts_enabled": true,
            "banner_enabled": false,
            "ducking_mode": SettingsTtsViewModel.duckingWire(.duck),
            "signal_only": true,
        ]
        let result = await client.patchNotificationSettings(body)
        XCTAssertNotNil(result, "reachable stub returns a 200 body")

        CapturingURLProtocol.lock.lock()
        let method = CapturingURLProtocol.capturedMethod
        let captured = CapturingURLProtocol.capturedBody
        CapturingURLProtocol.lock.unlock()

        XCTAssertEqual(method, "PATCH", "settings write must use the PATCH verb")
        let rawBody = try XCTUnwrap(captured, "the request body must reach the transport")
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: rawBody) as? [String: Any],
            "request body must be a JSON object"
        )

        XCTAssertEqual(json["tts_enabled"] as? Bool, true)
        XCTAssertEqual(json["banner_enabled"] as? Bool, false)
        XCTAssertEqual(json["signal_only"] as? Bool, true)
        XCTAssertEqual(json["ducking_mode"] as? String, "half",
                       "duck must be bridged to the server's `half` before it hits the wire")
        // No camelCase leakage — the keys that used to 400 must be absent.
        XCTAssertNil(json["ttsEnabled"], "camelCase key must not leak onto the wire")
        XCTAssertNil(json["signalOnly"], "camelCase key must not leak onto the wire")
    }


    func testPersistenceKeyParityPreservesValues() {
        // Set pre-redesign values via the SAME keys SettingsTtsView reads.
        let defaults = UserDefaults.standard
        defaults.set("duck", forKey: SettingsTtsKeys.ducking)
        defaults.set(true, forKey: SettingsTtsKeys.signalOnly)
        defaults.set(false, forKey: SettingsTtsKeys.banner)
        SettingsStore.shared.ttsEnabled = false

        let model = SettingsTtsViewModel()
        XCTAssertEqual(model.ducking, .duck, "ducking key should round-trip")
        XCTAssertTrue(model.signalOnly, "signalOnly key should round-trip")
        XCTAssertFalse(model.bannerEnabled, "banner key should round-trip")
        XCTAssertFalse(model.ttsEnabled, "ttsEnabled key should round-trip")

        // Cleanup so neighbouring tests see defaults.
        defaults.removeObject(forKey: SettingsTtsKeys.ducking)
        defaults.removeObject(forKey: SettingsTtsKeys.signalOnly)
        defaults.removeObject(forKey: SettingsTtsKeys.banner)
        SettingsStore.shared.ttsEnabled = true
    }

    func testKeyPasteRoundTripViaKeychain() {
        // Pre-seed Keychain so the masked display starts populated.
        try? Keychain.set("old-key-1234567890", for: KeychainAccount.elevenLabsApiKey)
        let model = SettingsTtsViewModel()
        XCTAssertNotEqual(model.apiKeyMaskedDisplay, "—")

        // Simulate paste + save.
        model.pasteApiKey = "new-key-ZZZZZZZZZZ"
        model.saveKey()
        let written = try? Keychain.get(KeychainAccount.elevenLabsApiKey)
        XCTAssertEqual(written, "new-key-ZZZZZZZZZZ")
        // Paste field is cleared post-save.
        XCTAssertTrue(model.pasteApiKey.isEmpty)
        // Masked display refreshes.
        XCTAssertNotEqual(model.apiKeyMaskedDisplay, "—")

        // Cleanup.
        try? Keychain.delete(KeychainAccount.elevenLabsApiKey)
    }

    // MARK: - Notification drawer's TTS toggle persists to the agent
    //
    // Spec: openspec/changes/fix-swift-tts-audit-defects (tasks 1.2 / 1.5).
    // The drawer's TTS toggle used to write only @AppStorage, so the flip never
    // reached the agent and peer machines / this listener after a restart never
    // learned about it — unlike the Meeting-mode toggle beside it.

    /// The drawer toggle's persist body carries `tts_enabled` in snake_case
    /// alongside the toggles that already worked.
    func testDrawerPersistBodyCarriesTtsEnabled() {
        let model = NotificationsViewModel()
        model.ttsEnabled = false
        model.meetingMode = true

        let body = model.persistBody()

        XCTAssertEqual(body["tts_enabled"] as? Bool, false,
                       "the drawer's TTS toggle must reach the wire")
        XCTAssertEqual(body["meeting_mode"] as? Bool, true)
        XCTAssertNil(body["ttsEnabled"], "camelCase key must not leak onto the wire")
    }

    /// Flipping it also writes the local `nx.tts.enabled` default, so the
    /// in-process TTSObserver reacts without waiting on the round trip.
    func testDrawerPersistWritesLocalDefaultImmediately() {
        let model = NotificationsViewModel()
        model.ttsEnabled = false
        model.persist()

        XCTAssertFalse(SettingsStore.shared.ttsEnabled,
                       "the local observer must see the flip immediately")

        // Cleanup so neighbouring tests see defaults.
        SettingsStore.shared.ttsEnabled = true
    }

    /// End-to-end on the wire: the drawer's body reaches the transport as a
    /// PATCH carrying `tts_enabled`, mirroring the TTS-settings case above.
    func testDrawerTogglePatchReachesTransport() async throws {
        CapturingURLProtocol.reset()
        let client = NexusShared.NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://agent.test/")!),
            protocolClasses: [CapturingURLProtocol.self]
        )

        let model = NotificationsViewModel()
        model.ttsEnabled = false
        let result = await client.patchNotificationSettings(model.persistBody())
        XCTAssertNotNil(result, "reachable stub returns a 200 body")

        CapturingURLProtocol.lock.lock()
        let method = CapturingURLProtocol.capturedMethod
        let captured = CapturingURLProtocol.capturedBody
        CapturingURLProtocol.lock.unlock()

        XCTAssertEqual(method, "PATCH", "settings write must use the PATCH verb")
        let rawBody = try XCTUnwrap(captured, "the request body must reach the transport")
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: rawBody) as? [String: Any],
            "request body must be a JSON object"
        )
        XCTAssertEqual(json["tts_enabled"] as? Bool, false,
                       "the drawer's TTS flip must land on the wire")

        SettingsStore.shared.ttsEnabled = true
    }

    func testProjectVoicesViewMountsInline() {
        // Smoke: SettingsTtsView's body must compile + reference
        // ProjectVoicesView in scope. Constructing the view exercises the
        // entire `var body` opaque return — a missing import or rename
        // would fail compile, then trip here at runtime.
        _ = SettingsTtsView()
        _ = ProjectVoicesView()
    }
}
