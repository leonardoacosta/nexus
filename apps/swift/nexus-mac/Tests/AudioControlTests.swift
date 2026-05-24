// AudioControlTests — unit coverage for the AirPods play/pause TTS-cancel
// feature.
//
// Spec: openspec/changes/airpods-tts-cancel (capability mac-tts-listener)
//
// Target placement
// ────────────────
// Lives in nexus-mac-Tests (the host-bundled test target, TEST_HOST =
// nexus.app per project.yml) rather than NexusSharedTests, matching the
// TTSObserverTests rationale: the concrete AudioPlayer surface + MediaPlayer
// remote-command registration are macOS-app-context sensitive, and the
// pre-push integration gate runs nexus-mac-Tests via the consolidated
// nexus-mac scheme.
//
// What we test
// ────────────
//   1. MP3PlayerProtocol.stop() — spy records the call; AudioPlayer.stop()
//      is a safe no-op when idle (no crash, no state change).
//   2. NowPlayingController — acquires on start; resigns ONLY after the
//      grace window elapses (uses a short injected grace); grace resets when
//      a new clip starts before it elapses; the remote-command handler
//      invokes the cancel hook.

import XCTest
@testable import NexusShared
// AudioPlayer (concrete MP3PlayerProtocol conformer) lives in the nexus-mac
// app target, whose product module name is `nexus` (PRODUCT_NAME = nexus).
@testable import nexus

// MARK: - Test doubles

/// MP3 player spy that records play() AND stop() so the cancel-routing
/// contract is observable.
private final class StoppableSpyPlayer: MP3PlayerProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var _playCount = 0
    private var _stopCount = 0

    var playCount: Int { lock.lock(); defer { lock.unlock() }; return _playCount }
    var stopCount: Int { lock.lock(); defer { lock.unlock() }; return _stopCount }

    func play(mp3Data: Data, ducking: DuckingMode) throws {
        lock.lock(); defer { lock.unlock() }
        _playCount += 1
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        _stopCount += 1
    }
}

// MARK: - MP3Player.stop() contract

@MainActor
final class AudioControlMP3PlayerTests: XCTestCase {
    /// stop() routes through the protocol surface and is recorded by the spy.
    func testStopRecordedBySpy() {
        let spy = StoppableSpyPlayer()
        XCTAssertEqual(spy.stopCount, 0)
        spy.stop()
        XCTAssertEqual(spy.stopCount, 1, "stop() must reach the player surface")
    }

    /// AudioPlayer.stop() when nothing is playing is a safe no-op — no crash,
    /// returns cleanly. (Concrete AudioPlayer lives in the nexus-mac target,
    /// reachable from this host-bundled test.)
    func testConcretePlayerStopIdleIsNoOp() {
        let player = AudioPlayer()
        // Never called play(); player is nil internally. Must not crash.
        player.stop()
        // A second stop() is equally safe.
        player.stop()
    }
}

// MARK: - NowPlayingController contract

@MainActor
final class NowPlayingControllerTests: XCTestCase {
    /// acquire() takes ownership of the session immediately.
    func testAcquireOwnsSession() {
        let controller = NowPlayingController(graceDuration: 0.1)
        XCTAssertFalse(controller.debugIsAcquired, "starts unacquired")
        controller.acquire()
        XCTAssertTrue(controller.debugIsAcquired, "acquire() owns the session")
        controller.resign()
    }

    /// After a clip ends, the session is HELD through the grace window and
    /// resigned only after it elapses.
    func testResignsOnlyAfterGrace() async {
        let controller = NowPlayingController(graceDuration: 0.2)
        controller.acquire()
        controller.noteClipEnded()
        // Immediately after clip end — still within grace.
        XCTAssertTrue(controller.debugIsAcquired,
                      "session held during the grace window")
        // Wait longer than the grace window.
        try? await Task.sleep(nanoseconds: 400_000_000) // 400ms > 200ms grace
        XCTAssertFalse(controller.debugIsAcquired,
                       "session resigned after grace elapsed")
    }

    /// A new clip starting before the grace elapses retains the session and
    /// restarts the window.
    func testGraceResetsOnNewClip() async {
        let controller = NowPlayingController(graceDuration: 0.3)
        controller.acquire()
        controller.noteClipEnded()
        // Partway through the grace, a new clip starts.
        try? await Task.sleep(nanoseconds: 150_000_000) // 150ms < 300ms
        XCTAssertTrue(controller.debugIsAcquired, "still held mid-grace")
        controller.acquire() // new clip — cancels pending resign
        // Wait past the ORIGINAL grace deadline; should still be held because
        // acquire() cancelled the resign and a new noteClipEnded() hasn't run.
        try? await Task.sleep(nanoseconds: 250_000_000) // 250ms (orig would've fired)
        XCTAssertTrue(controller.debugIsAcquired,
                      "new clip cancelled the prior resign — session retained")
        controller.resign()
    }

    /// A remote-command press invokes the cancel hook.
    func testRemoteCommandInvokesCancelHook() {
        let controller = NowPlayingController(graceDuration: 0.1)
        var cancelled = false
        controller.cancelHandler = { cancelled = true }
        controller.acquire()
        let consumed = controller.debugHandleRemoteCommand()
        XCTAssertTrue(consumed, "press while acquired is consumed")
        XCTAssertTrue(cancelled, "press invokes the cancel hook")
        controller.resign()
    }

    /// A press before any acquire is a no-op (no cancel hook fired).
    func testRemoteCommandBeforeAcquireIsNoOp() {
        let controller = NowPlayingController(graceDuration: 0.1)
        var cancelled = false
        controller.cancelHandler = { cancelled = true }
        let consumed = controller.debugHandleRemoteCommand()
        XCTAssertFalse(consumed)
        XCTAssertFalse(cancelled)
    }
}
