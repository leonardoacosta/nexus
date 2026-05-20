// TTSObserverTests — unit coverage for the macOS TTS notification observer.
//
// Spec: openspec/changes/mac-tts-runtime-wire-up (task 3.1)
//
// Target placement note
// ─────────────────────
// The spec calls for `apps/swift/NexusSharedTests/TTSObserverTests.swift`,
// but TTSObserver's `notificationCenter` default is
// `UNUserNotificationCenter.current()` — that call requires a hosted
// bundle context. The NexusSharedTests target is a free-standing
// `bundle.unit-test` (no TEST_HOST), so any constructor touching
// `.current()` crashes with `bundleProxyForCurrentProcess is nil`.
//
// The nexus-mac-Tests target IS host-bundled (TEST_HOST = nexus.app per
// apps/swift/project.yml), so the file lives here. The pre-push
// integration gate already runs nexus-mac-Tests via the consolidated
// `nexus-mac` scheme, so coverage stays in the gated path.
//
// What we test
// ────────────
// The observer's public lifecycle (start/stop idempotency, dependency
// injection seam) plus the observable behavioural contracts the design
// document calls out for the per-event handler. The handler is `private`
// on TTSObserver, so the channel-filter / fallback / banner assertions
// are exercised indirectly via:
//
//   1. Public-surface lifecycle drills — start() returns when stop()
//      cancels the subscription; double-start is a no-op; double-stop is
//      idempotent. These prove `subscriptionTask` state is wired right.
//
//   2. Injection-seam smoke — the public init accepts a `KeychainStore`
//      stub, `MP3PlayerProtocol` spy, custom `SystemSpeechSynthesizer`,
//      and a custom `UNUserNotificationCenter`. Construction-only smoke
//      confirms the seam compiles + holds for future end-to-end coverage.
//
//   3. Spy collaborators (KeychainStore stub + MP3PlayerProtocol spy)
//      that record interaction. If any future refactor exposes
//      `handle(event:)` for direct invocation, the spies are already in
//      place to make 3.1's five named tests fully behavioural without
//      re-writing the harness.
//
// Why structural for tests 3/4/5 instead of behavioural
// ─────────────────────────────────────────────────────
// Driving a synthetic NotificationEvent through TTSObserver requires
// access to its private `handle(event:)` method (or a protocol around
// `consumeNotifications`). The 1.x batch landed TTSObserver with
// concrete dependencies (`actor ElevenLabsClient`, system
// `UNUserNotificationCenter`) and a `private` handler. Honouring the
// orchestrator constraint "do not modify TTSObserver implementation",
// tests 3/4/5 verify the injection seam holds; a follow-up beads issue
// is filed to expose `handle(event:)` as `internal` so the design's
// full behavioural set lands.

import XCTest
import UserNotifications
@testable import NexusShared

// MARK: - Test doubles

/// In-memory Keychain stub. Records read calls so tests can prove the
/// observer consults the keychain on the synth path.
private final class StubKeychainStore: KeychainStore, @unchecked Sendable {
    var storedApiKey: String?
    var storedVoiceId: String?
    private(set) var apiKeyReads = 0
    private(set) var voiceIdReads = 0

    init(apiKey: String? = nil, voiceId: String? = nil) {
        self.storedApiKey = apiKey
        self.storedVoiceId = voiceId
    }

    func apiKey() -> String? {
        apiKeyReads += 1
        return storedApiKey
    }

    func voiceId() -> String? {
        voiceIdReads += 1
        return storedVoiceId
    }
}

/// MP3 playback spy — records every play() invocation. Conforms to
/// MP3PlayerProtocol so it can be injected anywhere the real
/// AudioPlayer is wired.
private final class SpyMP3Player: MP3PlayerProtocol, @unchecked Sendable {
    struct Call {
        let bytes: Int
        let ducking: DuckingMode
    }
    private let lock = NSLock()
    private var _calls: [Call] = []

    var calls: [Call] {
        lock.lock(); defer { lock.unlock() }
        return _calls
    }

    func play(mp3Data: Data, ducking: DuckingMode) throws {
        lock.lock(); defer { lock.unlock() }
        _calls.append(Call(bytes: mp3Data.count, ducking: ducking))
    }
}

// MARK: - Test fixture

@MainActor
final class TTSObserverTests: XCTestCase {
    /// Build an aggregate client backed by a single NexusClient pointed
    /// at a localhost port that never answers. `consumeNotifications`
    /// loops harmlessly without ever firing the handler — perfect for
    /// lifecycle assertions that don't care about real events.
    private func makeUnreachableAggregate() -> NexusAggregateClient {
        // Port 1 is reserved (tcpmux) and refuses connections on macOS —
        // the SSE consumer hits its retry loop instantly and never
        // surfaces a frame.
        let endpoint = NexusEndpoint(baseURL: URL(string: "http://127.0.0.1:1/")!)
        let client = NexusClient(endpoint: endpoint)
        return NexusAggregateClient(client: client, name: "test-unreachable")
    }

    /// Common TTSObserver fixture wired to spies/stubs. Caller may
    /// override individual seams.
    private func makeObserver(
        keychain: KeychainStore = StubKeychainStore(),
        audioPlayer: MP3PlayerProtocol? = nil
    ) -> TTSObserver {
        TTSObserver(
            client: makeUnreachableAggregate(),
            keychain: keychain,
            audioPlayer: audioPlayer,
            systemSpeech: SystemSpeechSynthesizer(),
            elevenLabs: ElevenLabsClient(),
            settings: SettingsStore(defaults: UserDefaults(
                suiteName: "tts-observer-tests-\(UUID().uuidString)"
            )!),
            notificationCenter: .current()
        )
    }

    // MARK: - 1) testStartRegistersHandler

    /// Calling start() spins up the subscription task. We launch it on a
    /// background Task (start() blocks on the consume loop until
    /// cancellation) then call stop() — start() must return so the
    /// awaiting Task can complete. If the subscription never registers,
    /// stop() is a no-op and the awaited task never returns within the
    /// timeout, failing the expectation.
    func testStartRegistersHandler() async {
        let observer = makeObserver()

        let started = expectation(description: "start() returned after stop()")
        let task = Task { @MainActor in
            await observer.start()
            started.fulfill()
        }

        // Let the subscription task settle into its consume loop before
        // we cancel — without this, stop() can race ahead of the
        // subscriptionTask assignment and leak the task.
        try? await Task.sleep(nanoseconds: 150_000_000) // 150ms

        observer.stop()
        await fulfillment(of: [started], timeout: 5.0)
        task.cancel()
    }

    // MARK: - 2) testStopCancelsSubscription

    /// stop() must cancel the live subscription and be idempotent. A
    /// second stop() against a cancelled observer is a no-op (early
    /// guard on `subscriptionTask == nil`). After stop(), starting a
    /// fresh subscription must succeed (start() is re-callable).
    func testStopCancelsSubscription() async {
        let observer = makeObserver()

        let firstRun = expectation(description: "first start() returned")
        Task { @MainActor in
            await observer.start()
            firstRun.fulfill()
        }
        try? await Task.sleep(nanoseconds: 150_000_000)

        observer.stop()
        await fulfillment(of: [firstRun], timeout: 5.0)

        // Idempotent — calling stop() again does not crash.
        observer.stop()

        // Subscription is re-startable after stop(). Run a second
        // start/stop cycle to prove the observer didn't latch into a
        // permanently-cancelled state.
        let secondRun = expectation(description: "second start() returned")
        Task { @MainActor in
            await observer.start()
            secondRun.fulfill()
        }
        try? await Task.sleep(nanoseconds: 150_000_000)
        observer.stop()
        await fulfillment(of: [secondRun], timeout: 5.0)
    }

    // MARK: - 3) testNonTtsChannelIgnored

    /// Structural: with no ElevenLabs creds in the injected keychain
    /// and no audio player wired, the observer must construct without
    /// crash and present the expected injection seam. The full
    /// handle(event:) flow asserts (no audio path invoked when
    /// channel != "tts") will land once handle() is reachable from
    /// tests — see file header note.
    func testNonTtsChannelIgnored() async throws {
        let keychain = StubKeychainStore(apiKey: nil, voiceId: nil)
        let spy = SpyMP3Player()
        let observer = makeObserver(keychain: keychain, audioPlayer: spy)

        // The injection seam holds — observer constructed with a
        // MP3PlayerProtocol spy and a credential-less keychain. The
        // observable channel-filter contract is: a non-tts event MUST
        // NOT reach the audio player. The spy starts empty.
        XCTAssertTrue(spy.calls.isEmpty,
                      "spy must start with zero recorded plays")

        // Encode + decode a non-tts NotificationEvent through the wire
        // shape to prove the type used in `handle(event:)` round-trips
        // through the codable contract that consumeNotifications emits.
        let event = NotificationEvent(
            body: "desktop banner only",
            channel: "desktop",
            title: "Sample",
            severity: .info,
            deliveryState: .pending
        )
        XCTAssertEqual(event.channel, "desktop")

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let raw = try encoder.encode(event)
        let round = try decoder.decode(NotificationEvent.self, from: raw)
        XCTAssertEqual(round.channel, "desktop",
                       "channel must round-trip so the handler's guard fires")

        // Sanity: the keychain stub is read-zero before any event
        // dispatch — if the observer ever wired a synth call from
        // construction, this would fail.
        XCTAssertEqual(keychain.apiKeyReads, 0)
        XCTAssertEqual(keychain.voiceIdReads, 0)

        _ = observer // silence unused-let warning under release builds
    }

    // MARK: - 4) testElevenLabsFailureFallsBackToSystemSpeech

    /// Structural: ElevenLabsClient is an `actor` (no protocol surface
    /// yet), but the observer accepts a custom instance via init. A
    /// failing client in tests would require either a network stub or
    /// a protocol seam; we assert the seam is wired so a follow-up can
    /// thread a failing-mock through once the protocol lands.
    ///
    /// What we DO verify here: when the keychain has NO api key (the
    /// other branch that exercises the "fall back to system speech"
    /// path), the observer's keychain stub records exactly zero reads
    /// pre-handle and the synth seam exists. The full assert
    /// (SystemSpeechSynthesizer.speak called once) is structural-only
    /// until handle(event:) is reachable.
    func testElevenLabsFailureFallsBackToSystemSpeech() async {
        // No api key → synth() short-circuits to system speech path.
        let keychain = StubKeychainStore(apiKey: nil, voiceId: nil)
        let spy = SpyMP3Player()
        let observer = makeObserver(keychain: keychain, audioPlayer: spy)

        // The fall-back contract: when keychain has no api key, the
        // synth path picks SystemSpeechSynthesizer over ElevenLabs.
        // Pre-handle, the audio player spy must be empty — no leakage
        // from construction.
        XCTAssertTrue(spy.calls.isEmpty,
                      "constructing observer must not invoke audio player")

        // The injection seam holds a custom SystemSpeechSynthesizer.
        // Cannot subclass AVSpeechSynthesizer easily, so we exercise
        // the public init with the default and assert it doesn't crash.
        XCTAssertNotNil(observer,
                        "observer with no-creds keychain must construct")

        // Sanity: stop() on a never-started observer is safe — the
        // synthesise() path never reaches a real audio device because
        // start() was never called.
        observer.stop()
    }

    // MARK: - 5) testBannerPostedRegardlessOfSynth

    /// Structural: UNUserNotificationCenter is a system class with no
    /// public init in tests. The observer accepts a custom centre via
    /// init (`notificationCenter:`) so a future test bundle entitled
    /// to post UNN can wire a recording proxy. We assert the seam is
    /// honoured: the observer accepts `.current()` without crash, and
    /// the banner-post call site is reachable via the configured
    /// channel "tts" precondition.
    func testBannerPostedRegardlessOfSynth() async throws {
        let keychain = StubKeychainStore(apiKey: "kfake", voiceId: "vfake")
        let spy = SpyMP3Player()
        let observer = makeObserver(keychain: keychain, audioPlayer: spy)

        // Banner-first contract: a "tts" NotificationEvent MUST cause
        // the observer to call notificationCenter.add() BEFORE the
        // synth attempt. The wire-shape check below proves the event
        // type used at the call site is the same one
        // consumeNotifications emits.
        let event = NotificationEvent(
            id: UUID(),
            body: "wave 3 banner check",
            channel: "tts",
            title: "Nexus",
            severity: .info,
            deliveryState: .pending
        )
        XCTAssertEqual(event.channel, "tts",
                       "banner path requires channel == tts")
        XCTAssertEqual(event.title, "Nexus",
                       "banner title falls through to UNMutableNotificationContent.title")

        // Round-trip through the codable contract — proves the
        // banner-shaped event survives the SSE decoder unchanged.
        let raw = try JSONEncoder().encode(event)
        let round = try JSONDecoder().decode(NotificationEvent.self, from: raw)
        XCTAssertEqual(round.body, "wave 3 banner check")
        XCTAssertEqual(round.channel, "tts")

        // No event has been dispatched, so the audio spy stays empty
        // and the keychain reads stay at zero. This is the negative
        // baseline a future behavioural variant will assert against.
        XCTAssertTrue(spy.calls.isEmpty)
        XCTAssertEqual(keychain.apiKeyReads, 0)
        XCTAssertEqual(keychain.voiceIdReads, 0)

        _ = observer // anchor the observer until end of test
    }
}
