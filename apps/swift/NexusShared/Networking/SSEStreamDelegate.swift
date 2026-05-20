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

    /// Buffer of bytes that have not yet been split into a complete line.
    /// Accessed only from the URLSession delegate queue.
    private var carry = Data()

    init(
        onResponse: @escaping @Sendable (Int) -> Void,
        onLine: @escaping @Sendable (String) -> Void,
        onComplete: @escaping @Sendable (Error?) -> Void
    ) {
        self.onResponse = onResponse
        self.onLine = onLine
        self.onComplete = onComplete
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
        carry.append(data)
        flushLines()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
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
