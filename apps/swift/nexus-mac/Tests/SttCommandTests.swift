// SttCommandTests — unit coverage for the AirPods double-press STT command.
//
// Spec: openspec/changes/airpods-stt-command (E2E batch, unit-level)
//
// Target placement note
// ─────────────────────
// Mirrors TTSObserverTests: lives in nexus-mac-Tests (host-bundled via
// TEST_HOST = nexus.app) rather than NexusSharedTests, because the
// behaviours under test wire through MainActor types that the gated
// `nexus-mac` scheme already runs. The pre-push integration gate executes
// this bundle automatically.
//
// What we test (no real mic / no network)
// ───────────────────────────────────────
//   1. SpeechController.start()/stop() finalizes a known transcript from an
//      injected stub TranscriptSource and delivers it via `onTranscript`.
//   2. NowPlayingController double-press OUTSIDE the Now-Playing window does
//      NOT start recording (the spec's core gating invariant).
//   3. Inside the window: a double-press fires `sttStartHandler`; a
//      subsequent press while recording fires `sttStopHandler` and does NOT
//      cancel TTS (cancelHandler stays untouched).
//   4. Routing-target selection (`TTSObserver.pickActiveSession`) picks the
//      most-recent active session for the tracked project; no match → nil
//      (the banner-fallback trigger).

import XCTest
@testable import NexusShared

// MARK: - Test double

/// Deterministic transcript source — `stopCapture()` returns a preset
/// string, no real recognizer or mic. Records start/stop for assertions.
@MainActor
private final class StubTranscriptSource: TranscriptSource {
    let transcript: String
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private var partialSink: ((String) -> Void)?

    init(transcript: String) {
        self.transcript = transcript
    }

    func startCapture(onPartial: @escaping (String) -> Void) throws {
        startCount += 1
        partialSink = onPartial
    }

    func stopCapture() -> String {
        stopCount += 1
        return transcript
    }

    /// Drive a partial result through the controller's pipeline in tests.
    func emitPartial(_ text: String) {
        partialSink?(text)
    }
}

/// A source whose `startCapture` throws — proves graceful no-op on denied
/// auth / unavailable recognizer (controller stays idle, no crash).
@MainActor
private final class FailingTranscriptSource: TranscriptSource {
    struct StartError: Error {}
    func startCapture(onPartial: @escaping (String) -> Void) throws {
        throw StartError()
    }
    func stopCapture() -> String { "" }
}

@MainActor
final class SttCommandTests: XCTestCase {

    // MARK: - 1) SpeechController finalizes a known transcript

    func testSpeechControllerFinalizesTranscript() {
        let stub = StubTranscriptSource(transcript: "run the tests")
        let controller = SpeechController(source: stub)

        var delivered: String?
        controller.onTranscript = { delivered = $0 }

        XCTAssertFalse(controller.isRecording)
        controller.start()
        XCTAssertTrue(controller.isRecording, "start() must enter recording state")
        XCTAssertEqual(stub.startCount, 1)

        controller.stop()
        XCTAssertFalse(controller.isRecording, "stop() must exit recording state")
        XCTAssertEqual(stub.stopCount, 1)
        XCTAssertEqual(delivered, "run the tests",
                       "stop() must deliver the finalized transcript")
    }

    func testSpeechControllerForwardsPartials() {
        let stub = StubTranscriptSource(transcript: "final")
        let controller = SpeechController(source: stub)

        var partials: [String] = []
        controller.onPartialTranscript = { partials.append($0) }

        controller.start()
        stub.emitPartial("ru")
        stub.emitPartial("run")
        controller.stop()

        XCTAssertEqual(partials, ["ru", "run"],
                       "partial hypotheses must reach onPartialTranscript")
    }

    func testSpeechControllerGracefulFailureStaysIdle() {
        let controller = SpeechController(source: FailingTranscriptSource())
        var delivered: String?
        controller.onTranscript = { delivered = $0 }

        controller.start()
        XCTAssertFalse(controller.isRecording,
                       "a throwing source must leave the controller idle")
        // stop() is a no-op when not recording — no transcript delivered.
        controller.stop()
        XCTAssertNil(delivered, "no transcript should be delivered after failed start")
    }

    func testSpeechControllerDoubleStartIgnored() {
        let stub = StubTranscriptSource(transcript: "x")
        let controller = SpeechController(source: stub)
        controller.start()
        controller.start() // ignored — already recording
        XCTAssertEqual(stub.startCount, 1,
                       "a second start() while recording must be ignored")
    }

    // MARK: - 2) Double-press OUTSIDE the Now-Playing window is a no-op

    func testDoublePressOutsideWindowDoesNotRecord() {
        let controller = NowPlayingController(graceDuration: 0.05)
        var startFired = false
        controller.sttStartHandler = { startFired = true }

        // Not acquired — the session is NOT held (no recent TTS).
        XCTAssertFalse(controller.debugIsAcquired)
        let consumed = controller.debugHandleNextTrack()

        XCTAssertFalse(consumed,
                       "a double-press with no held session must not be consumed")
        XCTAssertFalse(startFired,
                       "double-press outside the Now-Playing window must NOT start STT")
    }

    // MARK: - 3) In-window gesture map: start, then stop (not cancel)

    func testDoublePressInsideWindowStartsStt() {
        let controller = NowPlayingController(graceDuration: 0.05)
        var startFired = false
        var cancelFired = false
        controller.sttStartHandler = { startFired = true }
        controller.cancelHandler = { cancelFired = true }

        controller.acquire() // TTS playing — session held
        let consumed = controller.debugHandleNextTrack()

        XCTAssertTrue(consumed, "double-press in-window must be consumed")
        XCTAssertTrue(startFired, "double-press in-window must start STT")
        XCTAssertFalse(cancelFired, "starting STT must NOT cancel TTS")

        controller.resign()
    }

    func testPressWhileRecordingStopsAndDoesNotCancel() {
        let controller = NowPlayingController(graceDuration: 0.05)
        var stopFired = false
        var cancelFired = false
        controller.sttStopHandler = { stopFired = true }
        controller.cancelHandler = { cancelFired = true }

        controller.acquire()
        controller.isRecording = true // simulate active dictation

        // The "next press" — a play/pause press — must route to stop-and-send.
        let consumed = controller.debugHandleRemoteCommand()

        XCTAssertTrue(consumed)
        XCTAssertTrue(stopFired, "a press while recording must stop+send STT")
        XCTAssertFalse(cancelFired,
                       "a press while recording must NOT also cancel TTS")

        controller.resign()
    }

    func testPlayPausePressWhenNotRecordingCancelsTts() {
        // Regression guard: the airpods-tts-cancel behaviour survives.
        let controller = NowPlayingController(graceDuration: 0.05)
        var cancelFired = false
        var stopFired = false
        controller.cancelHandler = { cancelFired = true }
        controller.sttStopHandler = { stopFired = true }

        controller.acquire()
        // isRecording defaults false → play/pause cancels TTS.
        _ = controller.debugHandleRemoteCommand()

        XCTAssertTrue(cancelFired, "play/pause while idle must cancel TTS (legacy)")
        XCTAssertFalse(stopFired, "no STT stop when not recording")

        controller.resign()
    }

    // MARK: - 4) Routing-target selection (tracked session / no-session)

    func testPickActiveSessionPicksMostRecentForProject() {
        let now = Date()
        let older = Session(
            id: "sess-old", project: "oo", agent: "host-a",
            status: "active", lastHeartbeat: now.addingTimeInterval(-60)
        )
        let newer = Session(
            id: "sess-new", project: "oo", agent: "host-a",
            status: "active", lastHeartbeat: now
        )
        let otherProject = Session(
            id: "sess-other", project: "tc",
            status: "active", lastHeartbeat: now.addingTimeInterval(10)
        )

        let picked = TTSObserver.pickActiveSession(
            in: [older, otherProject, newer], project: "oo"
        )
        XCTAssertEqual(picked?.id, "sess-new",
                       "must pick the most-recent active session for the project")
    }

    func testPickActiveSessionIgnoresInactive() {
        let active = Session(id: "live", project: "oo", status: "active")
        let ended = Session(
            id: "dead", project: "oo", status: "ended",
            lastHeartbeat: Date().addingTimeInterval(100)
        )
        let picked = TTSObserver.pickActiveSession(in: [ended, active], project: "oo")
        XCTAssertEqual(picked?.id, "live",
                       "a more-recent but inactive session must be skipped")
    }

    func testPickActiveSessionNoMatchReturnsNil() {
        let other = Session(id: "x", project: "tc", status: "active")
        let picked = TTSObserver.pickActiveSession(in: [other], project: "oo")
        XCTAssertNil(picked,
                     "no active session for the project → nil (triggers banner fallback)")
    }

    // MARK: - 5) Last-notified project tracking seam

    func testObserverTracksAndClearsProjectSeam() {
        let endpoint = NexusEndpoint(baseURL: URL(string: "http://127.0.0.1:1/")!)
        let aggregate = NexusAggregateClient(
            client: NexusClient(endpoint: endpoint), name: "test"
        )
        let observer = TTSObserver(
            client: aggregate,
            keychain: LiveKeychainStore(),
            audioPlayer: nil,
            settings: SettingsStore(defaults: UserDefaults(
                suiteName: "stt-tests-\(UUID().uuidString)"
            )!),
            notificationCenter: .current()
        )

        XCTAssertNil(observer.debugLastNotifiedProject)
        observer.debugSetLastNotifiedProject("oo")
        XCTAssertEqual(observer.debugLastNotifiedProject, "oo",
                       "observer must retain the last-notified project for routing")
    }
}
