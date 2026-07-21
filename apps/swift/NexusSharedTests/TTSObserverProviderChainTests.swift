// TTSObserverProviderChainTests — provider-chain ordering contract.
//
// Spec: openspec/changes/swift-tts-provider-chain (task 1.5)
//
// Why these hit TTSObserver.buildAttempts/walkProviderChain instead of a
// full TTSObserver instance: constructing a full TTSObserver requires a
// UNUserNotificationCenter, and its default (`.current()`) crashes with
// "bundleProxyForCurrentProcess is nil" in this target — NexusSharedTests is
// a free-standing `bundle.unit-test` with no TEST_HOST (see the placement
// note atop apps/swift/nexus-mac/Tests/TTSObserverTests.swift, which lives
// in the host-bundled nexus-mac-Tests target for the same reason). The
// provider-chain gating/ordering logic was extracted into two `nonisolated
// static` pure functions specifically so this contract is testable without
// a notification-center dependency — mirrors the existing
// `pickActiveSession`/`renderBody` test-seam pattern in TTSObserver.swift.

import XCTest
@testable import NexusShared

final class TTSObserverProviderChainTests: XCTestCase {

    // MARK: - Test doubles

    private struct StubError: Error, Sendable {}

    /// Records every synthesize(text:voice:) call so a test can assert a
    /// provider was (or wasn't) invoked — a stronger claim than just reading
    /// the returned data, since "no HTTP request" is the actual scenario
    /// text for the empty-base-URL case.
    private actor CallRecorder {
        private(set) var calls: [(text: String, voice: String)] = []
        func record(text: String, voice: String) {
            calls.append((text, voice))
        }
    }

    private struct StubProvider: SpeechProvider {
        enum Outcome: Sendable {
            case success(Data)
            case failure
        }
        let outcome: Outcome
        let recorder: CallRecorder?

        init(_ outcome: Outcome, recorder: CallRecorder? = nil) {
            self.outcome = outcome
            self.recorder = recorder
        }

        func synthesize(text: String, voice: String) async throws -> Data {
            await recorder?.record(text: text, voice: voice)
            switch outcome {
            case .success(let data): return data
            case .failure: throw StubError()
            }
        }
    }

    private func mp3(bytes: Int) -> Data {
        Data(repeating: 0xAB, count: bytes)
    }

    // MARK: - Kokoro success short-circuits ElevenLabs

    func testKokoroSuccessShortCircuitsElevenLabs() async {
        let elevenRecorder = CallRecorder()
        let kokoro = StubProvider(.success(mp3(bytes: 2000)))
        let elevenLabs = StubProvider(.success(mp3(bytes: 2000)), recorder: elevenRecorder)

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: "http://homelab:8880",
            kokoroVoice: "af_heart",
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: "voice-1"
        )

        let result = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)

        guard case .played(let providerName, _) = result else {
            XCTFail("expected kokoro to win, got \(result)")
            return
        }
        XCTAssertEqual(providerName, "kokoro")
        let elevenCalls = await elevenRecorder.calls
        XCTAssertTrue(elevenCalls.isEmpty, "elevenlabs must not be attempted when kokoro succeeds")
    }

    // MARK: - Kokoro throw advances to ElevenLabs

    func testKokoroThrowAdvancesToElevenLabs() async {
        let kokoro = StubProvider(.failure)
        let elevenLabs = StubProvider(.success(mp3(bytes: 2000)))

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: "http://homelab:8880",
            kokoroVoice: nil,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: "voice-1"
        )

        let result = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)
        guard case .played(let providerName, _) = result else {
            XCTFail("expected fallback to elevenlabs, got \(result)")
            return
        }
        XCTAssertEqual(providerName, "elevenlabs")
    }

    // MARK: - Kokoro undersized payload advances to ElevenLabs

    func testKokoroUndersizedPayloadAdvancesToElevenLabs() async {
        let kokoro = StubProvider(.success(mp3(bytes: 100))) // < 1024-byte guard
        let elevenLabs = StubProvider(.success(mp3(bytes: 2000)))

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: "http://homelab:8880",
            kokoroVoice: nil,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: "voice-1"
        )

        let result = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)
        guard case .played(let providerName, _) = result else {
            XCTFail("expected fallback to elevenlabs, got \(result)")
            return
        }
        XCTAssertEqual(providerName, "elevenlabs")
    }

    // MARK: - Both providers failing lands on system speech

    func testBothProvidersFailingExhaustsChain() async {
        let kokoro = StubProvider(.failure)
        let elevenLabs = StubProvider(.failure)

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: "http://homelab:8880",
            kokoroVoice: nil,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: "voice-1"
        )

        let result = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)
        // .exhausted is TTSObserver.synthesise()'s signal to call
        // speakSystem(body:) — system speech.
        XCTAssertEqual(result, .exhausted)
    }

    // MARK: - Empty base URL skips the Kokoro attempt entirely (no request)

    func testEmptyKokoroBaseUrlSkipsAttemptEntirely() async {
        let kokoroRecorder = CallRecorder()
        let kokoro = StubProvider(.success(mp3(bytes: 2000)), recorder: kokoroRecorder)
        let elevenLabs = StubProvider(.success(mp3(bytes: 2000)))

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: "",
            kokoroVoice: nil,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: "voice-1"
        )

        XCTAssertEqual(attempts.map(\.name), ["elevenlabs"], "kokoro must be excluded from the attempt list")

        _ = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)
        let calls = await kokoroRecorder.calls
        XCTAssertTrue(calls.isEmpty, "kokoro must never be invoked when its base URL is empty")
    }

    func testNilKokoroBaseUrlSkipsAttemptEntirely() {
        let attempts = TTSObserver.buildAttempts(
            kokoro: StubProvider(.success(mp3(bytes: 2000))),
            elevenLabs: StubProvider(.success(mp3(bytes: 2000))),
            kokoroBaseUrl: nil,
            kokoroVoice: nil,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: "voice-1"
        )
        XCTAssertEqual(attempts.map(\.name), ["elevenlabs"])
    }

    // MARK: - No providers configured at all

    func testNoProvidersConfiguredProducesNoAttempts() {
        let attempts = TTSObserver.buildAttempts(
            kokoro: StubProvider(.success(mp3(bytes: 2000))),
            elevenLabs: StubProvider(.success(mp3(bytes: 2000))),
            kokoroBaseUrl: nil,
            kokoroVoice: nil,
            elevenLabsApiKeyPresent: false,
            elevenLabsVoiceId: nil
        )
        XCTAssertTrue(attempts.isEmpty)
    }

    // MARK: - Provider-qualified project voice routing (provider-qualified-project-voices, task 3.1/4.3)
    //
    // `TTSObserver.synthesise(event:)` cannot be exercised directly here (it
    // requires a live `TTSObserver` instance, which touches
    // `UNUserNotificationCenter.current()` and crashes outside a hosted
    // TEST_HOST bundle — same constraint documented atop this file). These
    // tests instead replicate the exact override-resolution switch
    // `synthesise(event:)` runs (parse the project voice via
    // `parseQualifiedVoice`, route `kokoro:` into `kokoroVoiceOverride`,
    // `elevenlabs:`/bare into `elevenLabsVoiceId`, anything else falls
    // through untouched) and feed the result into the real `buildAttempts` +
    // `walkProviderChain` statics — proving the parsed voice actually reaches
    // the provider that gets called, not just that parsing itself is correct.

    private static let baselineKokoroVoice = "settings-default-kokoro-voice"
    private static let baselineElevenLabsVoice = "keychain-default-eleven-voice"

    /// Mirrors the `synthesise(event:)` override switch (TTSObserver.swift,
    /// lines ~833-845) so each test below can compute the same
    /// `(kokoroVoiceOverride, elevenLabsVoiceId)` pair the real dispatch path
    /// would produce from a given project voice string.
    private func resolveOverride(projectVoice: String) -> (kokoro: String?, elevenLabs: String) {
        var kokoroVoiceOverride: String?
        var elevenLabsVoiceId = Self.baselineElevenLabsVoice
        let qualified = TTSObserver.parseQualifiedVoice(projectVoice)
        switch qualified.provider {
        case "kokoro":
            kokoroVoiceOverride = qualified.voice
        case "elevenlabs":
            elevenLabsVoiceId = qualified.voice
        default:
            break // unknown prefix — no override, baseline values stand
        }
        return (kokoroVoiceOverride, elevenLabsVoiceId)
    }

    func testKokoroQualifiedOverrideDrivesKokoroAttemptWithParsedVoice() async {
        let kokoroRecorder = CallRecorder()
        let kokoro = StubProvider(.success(mp3(bytes: 2000)), recorder: kokoroRecorder)
        let elevenLabs = StubProvider(.success(mp3(bytes: 2000)))

        let resolved = resolveOverride(projectVoice: "kokoro:af_bella")
        XCTAssertEqual(resolved.kokoro, "af_bella")
        XCTAssertEqual(resolved.elevenLabs, Self.baselineElevenLabsVoice, "elevenlabs resolution untouched by a kokoro: override")

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: "http://homelab:8880",
            kokoroVoice: resolved.kokoro ?? Self.baselineKokoroVoice,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: resolved.elevenLabs
        )
        XCTAssertEqual(attempts.first(where: { $0.name == "kokoro" })?.voice, "af_bella")

        let result = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)
        guard case .played(let providerName, _) = result else {
            XCTFail("expected kokoro to win, got \(result)")
            return
        }
        XCTAssertEqual(providerName, "kokoro")
        let kokoroCalls = await kokoroRecorder.calls
        XCTAssertEqual(kokoroCalls.map(\.voice), ["af_bella"], "kokoro must be invoked with the parsed override voice")
    }

    func testBareOverrideDrivesElevenLabsAttemptExactlyAsBefore() async {
        let elevenRecorder = CallRecorder()
        let elevenLabs = StubProvider(.success(mp3(bytes: 2000)), recorder: elevenRecorder)
        let kokoro = StubProvider(.success(mp3(bytes: 2000)))

        let resolved = resolveOverride(projectVoice: "voice-BARE-999")
        XCTAssertNil(resolved.kokoro, "a bare (unqualified) override must not touch the kokoro voice")
        XCTAssertEqual(resolved.elevenLabs, "voice-BARE-999")

        let attempts = TTSObserver.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: nil, // isolate: only elevenlabs should be attempted
            kokoroVoice: resolved.kokoro ?? Self.baselineKokoroVoice,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: resolved.elevenLabs
        )
        XCTAssertEqual(attempts.map(\.name), ["elevenlabs"])
        XCTAssertEqual(attempts.first?.voice, "voice-BARE-999")

        let result = await TTSObserver.walkProviderChain(text: "hello", attempts: attempts)
        guard case .played(let providerName, _) = result else {
            XCTFail("expected elevenlabs to win, got \(result)")
            return
        }
        XCTAssertEqual(providerName, "elevenlabs")
        let elevenCalls = await elevenRecorder.calls
        XCTAssertEqual(elevenCalls.map(\.voice), ["voice-BARE-999"])
    }

    func testUnknownPrefixFallsBackToNoOverrideBehavior() {
        let resolved = resolveOverride(projectVoice: "nope:xyz")
        // Unknown provider prefix -> no override applied at all: kokoro stays
        // unset (falls through to its own settings default) and elevenlabs
        // keeps the pre-override baseline — "xyz" must never surface as a
        // resolved voice anywhere.
        XCTAssertNil(resolved.kokoro)
        XCTAssertEqual(resolved.elevenLabs, Self.baselineElevenLabsVoice)

        let attempts = TTSObserver.buildAttempts(
            kokoro: StubProvider(.success(mp3(bytes: 2000))),
            elevenLabs: StubProvider(.success(mp3(bytes: 2000))),
            kokoroBaseUrl: "http://homelab:8880",
            kokoroVoice: resolved.kokoro ?? Self.baselineKokoroVoice,
            elevenLabsApiKeyPresent: true,
            elevenLabsVoiceId: resolved.elevenLabs
        )
        XCTAssertEqual(attempts.first(where: { $0.name == "kokoro" })?.voice, Self.baselineKokoroVoice)
        XCTAssertEqual(attempts.first(where: { $0.name == "elevenlabs" })?.voice, Self.baselineElevenLabsVoice)
        XCTAssertFalse(attempts.contains { $0.voice == "xyz" })
    }
}
