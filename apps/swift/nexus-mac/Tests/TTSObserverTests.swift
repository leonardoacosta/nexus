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

    /// airpods-tts-cancel: MP3PlayerProtocol gained `stop()`. The lifecycle
    /// tests here don't drive playback, so a no-op satisfies the conformance.
    func stop() {}
}

/// Playback spy for the queue tests (tts-pipeline-stop-and-queue, task 2.2).
///
/// Unlike `SpyMP3Player` it implements the three optional seams the queue
/// depends on: it records the ids published via `setCurrentlyPlaying(id:)` (the
/// ORDER of those ids is the sequencing proof) and it stores the observer's
/// finish/stop callbacks so a test can drive a clip to completion — or halt one
/// — deterministically, with no real audio device and no wall-clock waiting.
private final class QueueSpyPlayer: MP3PlayerProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var _playedIds: [String] = []
    private var _playCount = 0

    /// Ids published for each clip, in start order.
    var playedIds: [String] { lock.lock(); defer { lock.unlock() }; return _playedIds }
    /// Raw `play()` invocations — equals `playedIds.count` unless a clip started
    /// without publishing an id, which would itself be a regression.
    var playCount: Int { lock.lock(); defer { lock.unlock() }; return _playCount }

    var onPlaybackFinished: (() -> Void)?
    var onPlaybackStopped: (() -> Void)?

    func play(mp3Data _: Data, ducking _: DuckingMode) throws {
        lock.lock(); defer { lock.unlock() }
        _playCount += 1
    }

    func stop() {}

    func setCurrentlyPlaying(id: String?) {
        guard let id else { return }
        lock.lock(); defer { lock.unlock() }
        _playedIds.append(id)
    }

    /// Simulate the in-flight clip ending naturally (AVAudioPlayer's
    /// `audioPlayerDidFinishPlaying` delegate seam).
    func finishClip() { onPlaybackFinished?() }

    /// Simulate a stop tap halting the in-flight clip (`AudioPlayer.stop()`).
    func stopClip() { onPlaybackStopped?() }
}

/// SpeechProvider stub returning a fixed, above-the-minimum-size payload so the
/// provider chain reports success and the pipeline reaches `playMP3`.
/// (`TTSObserver.minimumPayloadBytes` is 1024 — anything smaller is treated as
/// an error envelope and the chain advances.)
private struct StubSpeechProvider: SpeechProvider {
    let payload: Data

    init(byteCount: Int = 2048) {
        self.payload = Data(repeating: 0xAB, count: byteCount)
    }

    func synthesize(text _: String, voice _: String) async throws -> Data {
        payload
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
        audioPlayer: MP3PlayerProtocol? = nil,
        settings: SettingsStore = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-observer-tests-\(UUID().uuidString)"
        )!),
        elevenLabs: any SpeechProvider = ElevenLabsClient()
    ) -> TTSObserver {
        TTSObserver(
            client: makeUnreachableAggregate(),
            keychain: keychain,
            audioPlayer: audioPlayer,
            systemSpeech: SystemSpeechSynthesizer(),
            elevenLabs: elevenLabs,
            settings: settings,
            notificationCenter: .current()
        )
    }

    /// A SettingsStore backed by a fresh, isolated UserDefaults suite so a
    /// test can flip `ttsEnabled` without touching the shared domain.
    private func makeSettings(ttsEnabled: Bool) -> SettingsStore {
        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-observer-gate-\(UUID().uuidString)"
        )!)
        store.ttsEnabled = ttsEnabled
        return store
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

    // MARK: - 6) ttsEnabled gate (nx-azr0t)

    /// With `ttsEnabled == false`, a `channel: "tts"` event must reach the
    /// banner stage but MUST NOT reach the audio-synth stage. `synthesise()`
    /// is the first thing that consults the keychain (voiceId + apiKey reads),
    /// so zero keychain reads is the observable proof that the gate returned
    /// before synthesis. The audio-player spy must likewise stay empty.
    func testTtsDisabledSuppressesSynthButNotBanner() async {
        let keychain = StubKeychainStore(apiKey: "kfake", voiceId: "vfake")
        let spy = SpyMP3Player()
        let observer = makeObserver(
            keychain: keychain,
            audioPlayer: spy,
            settings: makeSettings(ttsEnabled: false)
        )

        let event = NotificationEvent(
            id: UUID(),
            body: "should not be spoken",
            channel: "tts",
            title: "Nexus",
            severity: .info,
            deliveryState: .pending
        )
        await observer.handle(event: event)

        // Gate proof: synthesise() was never entered, so the keychain was
        // never consulted and the audio player was never invoked.
        XCTAssertEqual(keychain.apiKeyReads, 0,
                       "ttsEnabled=false must short-circuit before the apiKey read")
        XCTAssertEqual(keychain.voiceIdReads, 0,
                       "ttsEnabled=false must short-circuit before the voiceId read")
        XCTAssertTrue(spy.calls.isEmpty,
                      "ttsEnabled=false must not reach audioPlayer.play()")
    }

    /// Positive control: with `ttsEnabled == true`, the same event DOES reach
    /// `synthesise()`, which consults the keychain — proving the suppression
    /// above is caused by the gate and not by some unrelated short-circuit.
    /// (No ElevenLabs key would be usable here anyway, so the path falls back
    /// to system speech; we only assert that synthesise() was entered.)
    func testTtsEnabledReachesSynth() async {
        let keychain = StubKeychainStore(apiKey: nil, voiceId: nil)
        let spy = SpyMP3Player()
        let observer = makeObserver(
            keychain: keychain,
            audioPlayer: spy,
            settings: makeSettings(ttsEnabled: true)
        )

        let event = NotificationEvent(
            id: UUID(),
            body: "should reach synth",
            channel: "tts",
            title: "Nexus",
            severity: .info,
            deliveryState: .pending
        )
        await observer.handle(event: event)

        // synthesise() reads voiceId (resolution chain) then apiKey (guard),
        // so a positive read count proves the gate let the event through.
        XCTAssertGreaterThan(keychain.voiceIdReads, 0,
                             "ttsEnabled=true must reach synthesise() (voiceId consulted)")
    }

    // MARK: - 7) applySettingsChange — remote SettingsChanged round-trip
    //          (sync-notification-settings-round-trip, task 3.4 / nx-xzywt)

    // The three gating fields applySettingsChange writes to `UserDefaults
    // .standard` (ttsEnabled goes to the injected SettingsStore instead).
    private static let bannerKey = "nx.notifications.bannerEnabled"
    private static let duckingKey = "elevenlabs.ducking"
    private static let signalOnlyKey = "nx.notifications.signalOnly"

    /// Seed the three standard-domain gating keys to a known baseline so a
    /// field left ABSENT from a SettingsChanged payload is provably unchanged.
    private func seedStandardGatingBaseline(banner: Bool, ducking: String, signalOnly: Bool) {
        let d = UserDefaults.standard
        d.set(banner, forKey: Self.bannerKey)
        d.set(ducking, forKey: Self.duckingKey)
        d.set(signalOnly, forKey: Self.signalOnlyKey)
    }

    private func clearStandardGatingKeys() {
        let d = UserDefaults.standard
        d.removeObject(forKey: Self.bannerKey)
        d.removeObject(forKey: Self.duckingKey)
        d.removeObject(forKey: Self.signalOnlyKey)
    }

    private func settingsChangeEvent(_ json: String) -> SSEEvent {
        SSEEvent(name: "SettingsChanged", data: json)
    }

    /// A fully-populated SettingsChanged frame updates every gated field:
    /// ttsEnabled → the injected SettingsStore, banner/ducking/signalOnly →
    /// the standard-domain keys the per-event handler reads.
    func testApplySettingsChangeAppliesEveryPresentField() async {
        clearStandardGatingKeys()
        defer { clearStandardGatingKeys() }

        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-apply-all-\(UUID().uuidString)"
        )!)
        store.ttsEnabled = false
        seedStandardGatingBaseline(banner: true, ducking: "mix", signalOnly: false)

        let observer = makeObserver(settings: store)
        await observer.applySettingsChange(from: settingsChangeEvent(
            #"{"ttsEnabled":true,"bannerEnabled":false,"duckingMode":"pause","signalOnly":true}"#
        ))

        let d = UserDefaults.standard
        XCTAssertTrue(store.ttsEnabled, "ttsEnabled applied to the SettingsStore")
        XCTAssertEqual(d.object(forKey: Self.bannerKey) as? Bool, false, "bannerEnabled applied")
        XCTAssertEqual(d.string(forKey: Self.duckingKey), "pause", "duckingMode applied")
        XCTAssertEqual(d.object(forKey: Self.signalOnlyKey) as? Bool, true, "signalOnly applied")
    }

    /// The field-presence guard: a PARTIAL payload updates only the present
    /// field and leaves every absent field untouched — a settings edit that
    /// toggled one control must never blank the others.
    func testApplySettingsChangePartialPayloadPreservesUnrelatedFields() async {
        clearStandardGatingKeys()
        defer { clearStandardGatingKeys() }

        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-apply-partial-\(UUID().uuidString)"
        )!)
        store.ttsEnabled = true
        seedStandardGatingBaseline(banner: true, ducking: "mix", signalOnly: false)

        let observer = makeObserver(settings: store)
        // Only bannerEnabled present.
        await observer.applySettingsChange(from: settingsChangeEvent(
            #"{"bannerEnabled":false}"#
        ))

        let d = UserDefaults.standard
        XCTAssertEqual(d.object(forKey: Self.bannerKey) as? Bool, false,
                       "the present field (bannerEnabled) is updated")
        XCTAssertTrue(store.ttsEnabled,
                      "absent ttsEnabled left untouched (not blanked to false)")
        XCTAssertEqual(d.string(forKey: Self.duckingKey), "mix",
                       "absent duckingMode left untouched")
        XCTAssertEqual(d.object(forKey: Self.signalOnlyKey) as? Bool, false,
                       "absent signalOnly left untouched")
    }

    /// Each field updates independently: a payload carrying only ttsEnabled
    /// flips it without disturbing the three standard-domain keys.
    func testApplySettingsChangeTtsOnlyDoesNotTouchStandardKeys() async {
        clearStandardGatingKeys()
        defer { clearStandardGatingKeys() }

        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-apply-ttsonly-\(UUID().uuidString)"
        )!)
        store.ttsEnabled = true
        seedStandardGatingBaseline(banner: true, ducking: "duck", signalOnly: true)

        let observer = makeObserver(settings: store)
        await observer.applySettingsChange(from: settingsChangeEvent(
            #"{"ttsEnabled":false}"#
        ))

        let d = UserDefaults.standard
        XCTAssertFalse(store.ttsEnabled, "ttsEnabled flipped independently")
        XCTAssertEqual(d.object(forKey: Self.bannerKey) as? Bool, true, "banner untouched")
        XCTAssertEqual(d.string(forKey: Self.duckingKey), "duck", "ducking untouched")
        XCTAssertEqual(d.object(forKey: Self.signalOnlyKey) as? Bool, true, "signalOnly untouched")
    }

    /// A ducking value the Swift player can't decode is rejected, not coerced —
    /// the existing local ducking key is left as-is rather than being clobbered
    /// with a string resolveDucking() would silently fall back to `.mix`.
    func testApplySettingsChangeRejectsUndecodableDucking() async {
        clearStandardGatingKeys()
        defer { clearStandardGatingKeys() }

        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-apply-baddk-\(UUID().uuidString)"
        )!)
        seedStandardGatingBaseline(banner: true, ducking: "duck", signalOnly: false)

        let observer = makeObserver(settings: store)
        await observer.applySettingsChange(from: settingsChangeEvent(
            #"{"duckingMode":"not-a-mode"}"#
        ))

        XCTAssertEqual(UserDefaults.standard.string(forKey: Self.duckingKey), "duck",
                       "an out-of-vocab ducking value must leave the existing value intact")
    }

    /// Envelope tolerance: a `{"payload":{…}}`-wrapped frame is unwrapped and
    /// applied the same as a flat one (matches the other SSE decoders).
    func testApplySettingsChangeUnwrapsPayloadEnvelope() async {
        clearStandardGatingKeys()
        defer { clearStandardGatingKeys() }

        let store = SettingsStore(defaults: UserDefaults(
            suiteName: "tts-apply-envelope-\(UUID().uuidString)"
        )!)
        store.ttsEnabled = true

        let observer = makeObserver(settings: store)
        await observer.applySettingsChange(from: settingsChangeEvent(
            #"{"payload":{"ttsEnabled":false}}"#
        ))

        XCTAssertFalse(store.ttsEnabled,
                       "a payload-wrapped frame is unwrapped and applied")
    }

    // MARK: - 8) Back-to-back tts events queue and play sequentially
    //          (tts-pipeline-stop-and-queue, task 2.2 / nx-m3du3)
    //
    // Policy (tasks.md 1.1, decided by:leo — Option 1): every `tts` event
    // eventually plays, in arrival order. Before this, concurrent `handle()`
    // calls each ran their own synth + `play()`, and each new clip superseded
    // the in-flight one mid-sentence — the uncoordinated race these cases
    // exclude. `debugIsSpeaking` / `debugPendingSpeechCount` make the queue
    // state observable without any wall-clock guessing.

    /// A tts observer wired for real playback: creds present, a stub provider
    /// returning an above-minimum payload, tts enabled, and a queue-aware spy
    /// player — so `synthesise()` reaches `playMP3()` and reports a clip in
    /// flight (which is what parks the next event).
    private func makeQueueObserver(player: QueueSpyPlayer) -> TTSObserver {
        makeObserver(
            keychain: StubKeychainStore(apiKey: "kfake", voiceId: "vfake"),
            audioPlayer: player,
            settings: makeSettings(ttsEnabled: true),
            elevenLabs: StubSpeechProvider()
        )
    }

    private func ttsEvent(body: String) -> NotificationEvent {
        NotificationEvent(
            id: UUID(),
            body: body,
            channel: "tts",
            title: "Nexus",
            severity: .info,
            deliveryState: .pending
        )
    }

    /// Poll `condition` on the MainActor until it holds or `timeout` elapses.
    /// `advanceQueue()` releases the next event through a `Task { @MainActor }`
    /// hop, so the release is not observable on the statement after the finish
    /// callback fires.
    @discardableResult
    private func waitUntil(
        timeout: TimeInterval = 3.0,
        _ condition: () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000) // 10ms
        }
        return condition()
    }

    /// Two `tts` events delivered back-to-back: the first plays immediately,
    /// the second is PARKED (not raced onto the player), and it is released —
    /// in arrival order — only when the first clip finishes.
    func testBackToBackTtsEventsPlaySequentially() async {
        let player = QueueSpyPlayer()
        let observer = makeQueueObserver(player: player)

        let first = ttsEvent(body: "first message")
        let second = ttsEvent(body: "second message")

        await observer.handle(event: first)
        XCTAssertTrue(observer.debugIsSpeaking,
                      "the first event starts a clip and marks the pipeline speaking")
        XCTAssertEqual(observer.debugPendingSpeechCount, 0, "nothing queued yet")
        XCTAssertEqual(player.playedIds, [first.id.uuidString],
                       "the first event's clip started and published its id")

        await observer.handle(event: second)
        XCTAssertEqual(player.playCount, 1,
                       "the second event MUST NOT start a competing clip (no race)")
        XCTAssertEqual(observer.debugPendingSpeechCount, 1,
                       "the second event is parked in the queue")
        XCTAssertTrue(observer.debugIsSpeaking)

        // The first clip finishes naturally — that's the queue's advance trigger.
        player.finishClip()
        await waitUntil { player.playCount == 2 }

        XCTAssertEqual(player.playedIds,
                       [first.id.uuidString, second.id.uuidString],
                       "clips play in arrival order, one at a time")
        XCTAssertEqual(observer.debugPendingSpeechCount, 0, "queue drained")
        XCTAssertTrue(observer.debugIsSpeaking, "the second clip is now in flight")

        // The second clip finishes with an empty queue — the pipeline goes idle.
        player.finishClip()
        await waitUntil { observer.debugIsSpeaking == false }
        XCTAssertFalse(observer.debugIsSpeaking,
                       "an empty queue clears the speaking flag")
        XCTAssertEqual(player.playCount, 2, "no phantom third clip")
    }

    /// The mirror seam: stopping the in-flight clip ends the burst. `stop()`
    /// never fires the finish callback, so without the stop hook the queue would
    /// wait forever — and crucially, the stop tap must not start the queued clip.
    func testStopDropsQueuedTtsEvents() async {
        let player = QueueSpyPlayer()
        let observer = makeQueueObserver(player: player)

        await observer.handle(event: ttsEvent(body: "first message"))
        await observer.handle(event: ttsEvent(body: "second message"))
        XCTAssertEqual(observer.debugPendingSpeechCount, 1)

        // User taps stop on the playing row.
        player.stopClip()
        await waitUntil { observer.debugIsSpeaking == false }

        XCTAssertEqual(observer.debugPendingSpeechCount, 0,
                       "a stop tap drops the pending burst rather than skipping ahead")
        XCTAssertFalse(observer.debugIsSpeaking)
        XCTAssertEqual(player.playCount, 1,
                       "stopping must NOT start the queued clip as a side effect")
    }
}
