// SSEIdleWatchdogTests — verify SSEStreamDelegate's idle watchdog (nx-e1j52).
//
// THE BUG: the streaming URLSession sets
// `timeoutIntervalFor{Request,Resource} = .infinity` (intentional for a
// long-lived SSE stream). When the agent restarts behind a Tailscale relay,
// the TCP socket stays ESTABLISHED with no further bytes and no FIN/RST, so
// neither `didReceive data:` nor `didCompleteWithError` ever fires again. The
// consumer's `for try await` blocks forever and TTS dies until app relaunch.
//
// THE FIX: a `DispatchSourceTimer` watchdog armed on the 2xx response and
// re-armed on every received byte. After `idleTimeout` seconds of total
// silence it fires `onIdleTimeout` exactly once; the decoder turns that into a
// thrown `NexusClientError.idleTimeout` so the reconnect loop re-dials.
//
// These tests drive the watchdog directly via the `debug…Watchdog` test seams
// (no live URLSession needed — same `internal func debug…` convention used by
// NowPlayingController). A TINY `idleTimeout` keeps them fast; expectation
// timeouts are generous relative to that interval so they stay deterministic
// under CI load.

import XCTest
@testable import NexusShared

final class SSEIdleWatchdogTests: XCTestCase {
    /// A silent stream (no bytes after arming) MUST fire `onIdleTimeout`
    /// within roughly `idleTimeout`. This is the dead-agent-behind-relay case.
    func testIdleTimeoutFiresWhenNoBytesArrive() {
        let fired = expectation(description: "onIdleTimeout fired")
        let delegate = SSEStreamDelegate(
            idleTimeout: 0.05,
            onResponse: { _ in },
            onLine: { _ in },
            onComplete: { _ in },
            onIdleTimeout: { fired.fulfill() }
        )

        // Arm as the 2xx-response path would; feed NO bytes.
        delegate.debugArmWatchdog()

        // 0.05s interval; wait up to 2s — generous margin, still deterministic.
        wait(for: [fired], timeout: 2.0)
    }

    /// `onIdleTimeout` MUST fire at most once even if the deadline could be hit
    /// repeatedly — the latch makes the idle path idempotent.
    func testIdleTimeoutFiresExactlyOnce() {
        let fired = expectation(description: "onIdleTimeout fired")
        // Inverted: failing the test if it fires a SECOND time.
        fired.expectedFulfillmentCount = 1
        fired.assertForOverFulfill = true

        let delegate = SSEStreamDelegate(
            idleTimeout: 0.05,
            onResponse: { _ in },
            onLine: { _ in },
            onComplete: { _ in },
            onIdleTimeout: { fired.fulfill() }
        )
        delegate.debugArmWatchdog()
        wait(for: [fired], timeout: 2.0)

        // Give the timer queue extra wall-clock time to (incorrectly) re-fire.
        // `assertForOverFulfill` would trip the test if the latch failed.
        let settle = expectation(description: "settle window")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            settle.fulfill()
        }
        wait(for: [settle], timeout: 2.0)
    }

    /// A byte arriving before expiry MUST push the deadline forward — a
    /// healthy stream (keepalive every 30s, well under the 45s prod window) is
    /// never killed. We arm with a small interval, re-arm shortly after, and
    /// assert no fire within the ORIGINAL window.
    func testReceivingBytesResetsTheWatchdog() {
        let mustNotFireEarly = expectation(description: "no early idle fire")
        mustNotFireEarly.isInverted = true

        let delegate = SSEStreamDelegate(
            idleTimeout: 0.40,
            onResponse: { _ in },
            onLine: { _ in },
            onComplete: { _ in },
            onIdleTimeout: { mustNotFireEarly.fulfill() }
        )

        delegate.debugArmWatchdog()

        // Re-arm at ~0.15s (well before the 0.40s deadline) to reset the timer,
        // the way `didReceive data:` does on each byte/keepalive. After this the
        // real deadline is pushed to ~0.55s.
        let rearmed = expectation(description: "rearm scheduled")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
            delegate.debugRearmWatchdog()
            rearmed.fulfill()
        }
        wait(for: [rearmed], timeout: 2.0)

        // From the re-arm point (~t=0.15), assert NO fire for another 0.30s
        // (through ~t=0.45). The original 0.40s deadline would have elapsed in
        // this window had the byte NOT reset it; the re-armed ~0.55s deadline
        // has not — so the inverted expectation must stay unfulfilled, proving
        // the reset took effect.
        wait(for: [mustNotFireEarly], timeout: 0.30)
    }

    /// `didCompleteWithError` teardown (clean close / transport error) MUST
    /// claim the latch so a timer expiry racing the completion is suppressed —
    /// the decoder already finished via `onComplete`, so a stray idle-fire
    /// would be a spurious second termination.
    func testCompletionSuppressesIdleFire() {
        let mustNotFire = expectation(description: "idle fire suppressed")
        mustNotFire.isInverted = true

        let delegate = SSEStreamDelegate(
            idleTimeout: 0.05,
            onResponse: { _ in },
            onLine: { _ in },
            onComplete: { _ in },
            onIdleTimeout: { mustNotFire.fulfill() }
        )

        delegate.debugArmWatchdog()
        // Cancel (teardown) immediately — claims the idle latch before the
        // 0.05s deadline can elapse.
        delegate.debugCancelWatchdog()

        // Wait past the interval; the inverted expectation must NOT fulfill.
        wait(for: [mustNotFire], timeout: 0.5)
    }

    /// `NexusClientError.idleTimeout` is a distinct, addressable case — guards
    /// the wiring SSEDecoder relies on (`continuation.finish(throwing:)`).
    func testIdleTimeoutErrorCaseIsDistinct() {
        let err: NexusClientError = .idleTimeout
        if case .idleTimeout = err {
            // expected
        } else {
            XCTFail("NexusClientError.idleTimeout did not match itself")
        }
        // And it is NOT confused with the other transport-class cases.
        if case .badStatus = err { XCTFail("idleTimeout matched .badStatus") }
        if case .transport = err { XCTFail("idleTimeout matched .transport") }
        if case .decoding = err { XCTFail("idleTimeout matched .decoding") }
    }
}
