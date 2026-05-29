// SSEStreamDelegate — URLSessionDataDelegate-based byte pump for SSE.
//
// Spec: nx-60zzf (TTSObserver handler not firing despite ESTABLISHED socket).
//
// `URLSession.AsyncBytes.lines` buffers chunked text/event-stream bytes over
// HTTP/1.1+HTTP/2 until the connection closes or buffer pressure builds.
// On localhost-low-traffic streams (one frame per nx_notify) this manifests
// as zero per-event log entries despite a verified TCP ESTABLISHED socket
// (proven via independent `curl -sN` capturing the same frames).
//
// This delegate restores immediate, per-chunk delivery: each
// `urlSession(_:dataTask:didReceive:)` callback decodes the new bytes,
// splits on `\n`, carries a trailing partial line across chunks, and
// forwards complete lines (with any trailing `\r` stripped) to a callback.
//
// The receiver type is `@unchecked Sendable` because the delegate is only
// touched from URLSession's serial delegate queue (see `init` config), so
// the mutable byte buffer is effectively serialised by the runtime.
//
// Idle watchdog (nx-e1j52): the streaming URLSession uses
// `timeoutIntervalFor{Request,Resource} = .infinity` so a healthy long-lived
// SSE stream is never killed. When the agent process restarts, the Tailscale
// relay can hold the TCP socket ESTABLISHED — no bytes, no FIN/RST — so
// neither `didReceive data:` nor `didCompleteWithError` ever fires again and
// the consumer's `for await` blocks forever (TTS dies until app relaunch).
// A `DispatchSourceTimer` watchdog distinguishes "dead" from "healthy": the
// agent sends a `: keepalive\n\n` comment every 30s, so ~45s of total silence
// reliably means the peer is gone. On expiry we fire `onIdleTimeout` exactly
// once; the decoder turns that into `finish(throwing: .idleTimeout)`, so the
// consume loop throws and the reconnect loop re-dials. The watchdog timer
// lives on its own serial queue (NOT the delegate `OperationQueue`) so it can
// never deadlock against the byte pump.

import Foundation
import OSLog

private let streamLogger = Logger(
    subsystem: "dev.leonardoacosta.nexus.mac",
    category: "SSEStream"
)

/// `URLSessionDataDelegate` that emits per-line callbacks for an SSE stream.
final class SSEStreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    /// Callback fired per complete line (no trailing newline, `\r` stripped).
    private let onLine: @Sendable (String) -> Void
    /// Callback fired once headers arrive; receives the HTTP status code.
    private let onResponse: @Sendable (Int) -> Void
    /// Callback fired on terminal completion (success or error).
    private let onComplete: @Sendable (Error?) -> Void
    /// Callback fired EXACTLY ONCE when no bytes arrive for `idleTimeout`
    /// seconds (nx-e1j52). The decoder maps this to a thrown
    /// `NexusClientError.idleTimeout` so the reconnect loop re-dials.
    private let onIdleTimeout: @Sendable () -> Void

    /// Seconds of total silence (no `didReceive data:`) that mark the stream
    /// dead. Default 45 sits above the agent's 30s keepalive cadence so a
    /// healthy stream re-arms before the deadline; injectable for tests.
    private let idleTimeout: TimeInterval

    /// Buffer of bytes that have not yet been split into a complete line.
    /// Accessed only from the URLSession delegate queue.
    private var carry = Data()

    // MARK: Idle watchdog state (nx-e1j52)

    /// Dedicated serial queue for the watchdog timer + its mutable state.
    /// Deliberately NOT the URLSession delegate `OperationQueue` — keeping the
    /// timer on its own queue means an expiry callback can never block (or be
    /// blocked by) a `didReceive data:` byte-pump callback.
    private let watchdogQueue = DispatchQueue(
        label: "dev.leonardoacosta.nexus.sse.watchdog"
    )
    /// The watchdog timer. nil until armed; torn down on completion. Touched
    /// only on `watchdogQueue`.
    private var watchdog: DispatchSourceTimer?
    /// Latch so the idle path fires `onIdleTimeout` at most once and races
    /// with `didCompleteWithError` resolve to a single winner. Touched only on
    /// `watchdogQueue`.
    private var idleFired = false

    init(
        idleTimeout: TimeInterval = 45,
        onResponse: @escaping @Sendable (Int) -> Void,
        onLine: @escaping @Sendable (String) -> Void,
        onComplete: @escaping @Sendable (Error?) -> Void,
        onIdleTimeout: @escaping @Sendable () -> Void = {}
    ) {
        self.idleTimeout = idleTimeout
        self.onResponse = onResponse
        self.onLine = onLine
        self.onComplete = onComplete
        self.onIdleTimeout = onIdleTimeout
        super.init()
    }

    // MARK: URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        if let http = response as? HTTPURLResponse {
            streamLogger.info("SSEStream: response status=\(http.statusCode, privacy: .public)")
            onResponse(http.statusCode)
            // Arm the idle watchdog only for a streamable 2xx response. A
            // non-2xx is surfaced+finished by `onResponse` already, so there's
            // no live stream to watch.
            if (200...299).contains(http.statusCode) {
                armWatchdog()
            }
        } else {
            onResponse(0)
        }
        completionHandler(.allow)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        streamLogger.debug("SSEStream: didReceive bytes=\(data.count)")
        // Any byte (data frame OR keepalive comment) proves the peer is alive;
        // push the idle deadline forward.
        rearmWatchdog()
        carry.append(data)
        flushLines()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        // Tear the watchdog down first and claim the idle latch, so a timer
        // expiry that races this completion loses (idle-fire is suppressed).
        cancelWatchdog()
        // Flush any final unterminated line — SSE frames must end in \n\n,
        // so a trailing partial line at EOF is malformed but we surface it
        // anyway for diagnostics.
        if !carry.isEmpty {
            if let s = String(data: carry, encoding: .utf8) {
                onLine(stripCR(s))
            }
            carry.removeAll(keepingCapacity: false)
        }
        if let error = error {
            streamLogger.error("SSEStream: didComplete error=\(error.localizedDescription, privacy: .public)")
        } else {
            streamLogger.info("SSEStream: didComplete clean")
        }
        onComplete(error)
    }

    // MARK: - Idle watchdog (nx-e1j52)

    /// Start the watchdog. Idempotent-ish: scheduling a fresh timer simply
    /// supersedes any prior one. Called once on a 2xx response.
    private func armWatchdog() {
        watchdogQueue.async { [weak self] in
            self?.scheduleTimerLocked()
        }
    }

    /// Push the idle deadline forward on every received byte. Cheap: cancels
    /// the in-flight timer and schedules a new one `idleTimeout` out.
    private func rearmWatchdog() {
        watchdogQueue.async { [weak self] in
            guard let self else { return }
            // Once the idle path (or completion) has fired, do NOT resurrect
            // the timer — the stream is being torn down.
            if self.idleFired { return }
            self.scheduleTimerLocked()
        }
    }

    /// Cancel the watchdog and claim the idle latch so a concurrently-firing
    /// expiry loses the race. MUST run on `watchdogQueue` — `cancelWatchdog`
    /// hops there; the timer handler is already on it.
    private func cancelWatchdog() {
        watchdogQueue.async { [weak self] in
            guard let self else { return }
            self.idleFired = true
            self.watchdog?.cancel()
            self.watchdog = nil
        }
    }

    /// (Re)create the timer. MUST be called on `watchdogQueue`.
    private func scheduleTimerLocked() {
        watchdog?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: watchdogQueue)
        timer.schedule(deadline: .now() + idleTimeout)
        timer.setEventHandler { [weak self] in
            self?.fireIdleLocked()
        }
        watchdog = timer
        timer.resume()
    }

    /// Timer expiry. Runs on `watchdogQueue`, so `idleFired` and `watchdog`
    /// are accessed without further locking. Fires `onIdleTimeout` exactly
    /// once — a teardown (`cancelWatchdog`) that already set the latch wins.
    private func fireIdleLocked() {
        if idleFired { return }
        idleFired = true
        watchdog?.cancel()
        watchdog = nil
        streamLogger.error(
            "SSEStream: idle timeout (\(self.idleTimeout, privacy: .public)s) — forcing reconnect"
        )
        onIdleTimeout()
    }

    // MARK: - Test seams (nx-e1j52)

    /// Arm the watchdog without a live URLSession — mirrors the
    /// `didReceive response:` 2xx path. Used by NexusSharedTests to drive the
    /// idle-fire deterministically with a tiny `idleTimeout`. (Same
    /// `internal func debug…` convention as NowPlayingController.)
    internal func debugArmWatchdog() {
        armWatchdog()
    }

    /// Re-arm the watchdog without a live URLSession — mirrors the
    /// `didReceive data:` reset path. Used by NexusSharedTests to prove a byte
    /// arriving before expiry pushes the deadline forward.
    internal func debugRearmWatchdog() {
        rearmWatchdog()
    }

    /// Tear the watchdog down without a live URLSession — mirrors the
    /// `didCompleteWithError` teardown path. Lets tests prove a completion
    /// suppresses a subsequent idle-fire.
    internal func debugCancelWatchdog() {
        cancelWatchdog()
    }

    // MARK: - Line splitting

    /// Split `carry` on `\n`, emit each complete line, keep the trailing
    /// partial line buffered for the next chunk.
    private func flushLines() {
        let lf: UInt8 = 0x0A
        var searchStart = carry.startIndex
        while let lfIndex = carry[searchStart..<carry.endIndex].firstIndex(of: lf) {
            let lineData = carry[searchStart..<lfIndex]
            if let lineString = String(data: lineData, encoding: .utf8) {
                onLine(stripCR(lineString))
            }
            searchStart = carry.index(after: lfIndex)
        }
        if searchStart == carry.startIndex {
            // No newline found; keep the whole buffer for the next chunk.
            return
        }
        if searchStart == carry.endIndex {
            // Every byte consumed.
            carry.removeAll(keepingCapacity: true)
        } else {
            // Drop the consumed prefix, keep the partial-line suffix.
            carry = Data(carry[searchStart..<carry.endIndex])
        }
    }

    private func stripCR(_ s: String) -> String {
        s.hasSuffix("\r") ? String(s.dropLast()) : s
    }
}
