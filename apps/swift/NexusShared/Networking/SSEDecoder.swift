// SSEDecoder — parse the agent's Server-Sent Events stream.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.3)
//
// Agent emits `event: <name>\ndata: <json>\n\n` frames per
// apps/agent/src/routes/events-sse.ts. The decoder lifts each frame to a
// typed `SSEEvent`; per-event payload decoding lives in extensions below.

import Foundation
import OSLog

private let sseLogger = Logger(subsystem: "dev.leonardoacosta.nexus.mac", category: "SSEDecoder")

/// A decoded SSE frame from the agent's `/events/stream`.
public struct SSEEvent: Equatable, Sendable {
    public var name: String
    public var data: String

    public init(name: String, data: String) {
        self.name = name
        self.data = data
    }
}

public enum SSEDecoder {
    /// Consume an SSE endpoint, invoking `handler` per `event:`-named frame.
    /// Throws on transport / status failure (caller is responsible for retry).
    ///
    /// Implementation note (nx-60zzf):
    /// The previous implementation used `URLSession.bytes(for:).lines`, which
    /// buffers chunked `text/event-stream` bytes on macOS until the connection
    /// closes or buffer pressure builds — fatal for a low-rate notification
    /// stream where each event is ~150 B and may arrive seconds apart. The
    /// `session` argument is no longer used for the streaming request itself;
    /// it is retained in the signature for caller compatibility. A fresh
    /// `URLSession` with a `URLSessionDataDelegate` (`SSEStreamDelegate`) is
    /// built per call so we observe `didReceive data:` callbacks per TCP
    /// chunk and forward lines immediately. The delegate session is
    /// invalidated when the consume Task is cancelled or the stream ends.
    /// `idleTimeout` (nx-e1j52): seconds of total stream silence — no
    /// `didReceive data:` callback, not even the agent's 30s `: keepalive`
    /// comment — after which the stream is force-finished with
    /// `NexusClientError.idleTimeout`. This is the ONLY way the consumer
    /// notices a dead-but-ESTABLISHED socket (agent restart behind a Tailscale
    /// relay): with `timeoutIntervalFor{Request,Resource} = .infinity` set
    /// intentionally for the long-lived stream, neither URLSession timeout nor
    /// `didCompleteWithError` ever fires. Default 45 sits above the keepalive
    /// cadence; tests inject a tiny value for determinism.
    public static func consume(
        url: URL,
        session: URLSession,
        idleTimeout: TimeInterval = 45,
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async throws {
        _ = session  // see implementation note above

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = TimeInterval.infinity
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        let cfg = URLSessionConfiguration.default
        cfg.httpAdditionalHeaders = ["Accept": "text/event-stream"]
        cfg.timeoutIntervalForRequest = TimeInterval.infinity
        cfg.timeoutIntervalForResource = TimeInterval.infinity
        cfg.httpMaximumConnectionsPerHost = 1
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        // HTTP/2 multiplexing is the buffering culprit on macOS for chunked
        // text/event-stream. Disabling pipelining and capping per-host
        // connections nudges URLSession toward a dedicated HTTP/1.1 stream.
        cfg.httpShouldUsePipelining = false

        // AsyncThrowingStream bridges the delegate callbacks (which run on
        // URLSession's serial delegate queue) into the async caller's task.
        let lineStream = AsyncThrowingStream<String, Error> { continuation in
            let delegate = SSEStreamDelegate(
                idleTimeout: idleTimeout,
                onResponse: { status in
                    if !(200...299).contains(status) {
                        continuation.finish(throwing: NexusClientError.badStatus(status))
                    }
                },
                onLine: { line in
                    continuation.yield(line)
                },
                onComplete: { error in
                    if let error = error {
                        continuation.finish(throwing: NexusClientError.transport(error))
                    } else {
                        continuation.finish()
                    }
                },
                onIdleTimeout: {
                    // No bytes for the idle window — the agent likely
                    // restarted behind a relay that's holding the socket
                    // ESTABLISHED. Finish the stream so `for try await`
                    // throws, `consume()` throws, and `reconnectLoop`
                    // re-dials. `continuation.onTermination` (below) cancels
                    // the dataTask + invalidates the session.
                    sseLogger.error(
                        "SSEDecoder: idle timeout — forcing reconnect url=\(url.absoluteString, privacy: .public)"
                    )
                    continuation.finish(throwing: NexusClientError.idleTimeout)
                }
            )
            let delegateQueue = OperationQueue()
            delegateQueue.maxConcurrentOperationCount = 1
            delegateQueue.name = "dev.leonardoacosta.nexus.sse"
            let urlSession = URLSession(configuration: cfg, delegate: delegate, delegateQueue: delegateQueue)
            let task = urlSession.dataTask(with: req)
            continuation.onTermination = { _ in
                task.cancel()
                urlSession.invalidateAndCancel()
            }
            task.resume()
        }

        sseLogger.info("SSEDecoder: connected url=\(url.absoluteString, privacy: .public)")

        var currentEvent: String?
        var currentData = ""
        for try await line in lineStream {
            sseLogger.debug("SSEDecoder: line len=\(line.count) prefix=\(String(line.prefix(40)), privacy: .public)")
            if line.isEmpty {
                // Dispatch the frame on blank-line boundary.
                if let name = currentEvent, !currentData.isEmpty {
                    await handler(SSEEvent(name: name, data: currentData))
                    sseLogger.info("SSEDecoder: dispatched event=\(name, privacy: .public) data_len=\(currentData.count)")
                } else if !currentData.isEmpty {
                    await handler(SSEEvent(name: "message", data: currentData))
                    sseLogger.info("SSEDecoder: dispatched event=message data_len=\(currentData.count)")
                }
                currentEvent = nil
                currentData = ""
                continue
            }
            if line.hasPrefix(":") { continue } // comment / keepalive
            if line.hasPrefix("event:") {
                currentEvent = line.dropFirst("event:".count)
                    .trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let chunk = line.dropFirst("data:".count)
                    .trimmingCharacters(in: .whitespaces)
                if currentData.isEmpty { currentData = chunk }
                else { currentData += "\n" + chunk }
            }
        }
    }
}

// MARK: - Per-event payload decoders

extension SSEEvent {
    /// `RemoteSessionStarted` carries the new session under either
    /// `payload.session` or directly on the envelope.
    public func decodeSession(using decoder: JSONDecoder = JSONDecoder()) -> Session? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        if let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            if let session = env["session"] as? [String: Any],
               let nested = try? JSONSerialization.data(withJSONObject: session),
               let row = try? decoder.decode(Session.self, from: nested) {
                return row
            }
            if let payload = env["payload"] as? [String: Any],
               let session = payload["session"] as? [String: Any],
               let nested = try? JSONSerialization.data(withJSONObject: session),
               let row = try? decoder.decode(Session.self, from: nested) {
                return row
            }
            if let row = try? decoder.decode(Session.self, from: bytes) {
                return row
            }
        }
        return nil
    }

    /// `RemoteSessionEnded` carries either `sessionId` or `id` at any level.
    public func decodeSessionId() -> String? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        if let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            if let id = env["sessionId"] as? String { return id }
            if let id = env["id"] as? String { return id }
            if let p = env["payload"] as? [String: Any] {
                if let id = p["sessionId"] as? String { return id }
                if let id = p["id"] as? String { return id }
            }
        }
        return nil
    }

    /// `HomelabHeartbeat` envelope — returns whichever metrics are present.
    public func decodeHeartbeatMetrics() -> (cpu: Double?, ram: Double?) {
        guard let bytes = data.data(using: .utf8) else { return (nil, nil) }
        guard let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            return (nil, nil)
        }
        let cpu = (env["cpu_percent"] as? Double)
            ?? ((env["payload"] as? [String: Any])?["cpu_percent"] as? Double)
        let ram = (env["ram_percent"] as? Double)
            ?? ((env["payload"] as? [String: Any])?["ram_percent"] as? Double)
        return (cpu, ram)
    }

    /// `VoiceOverrideChanged` — agent emits this AFTER a PUT or DELETE
    /// on `/notifications/voices/:project` commits. Returns the project
    /// slug whose mapping changed, or nil if the frame cannot be parsed.
    /// (notifications-overhaul, task 3.4)
    public func decodeVoiceOverrideChange() -> String? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        if let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            let p = (env["payload"] as? [String: Any]) ?? env
            return p["project"] as? String
        }
        return nil
    }

    /// `NotificationFired` — body+channel+title+emoji envelope.
    public func decodeNotification() -> NotificationEvent? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        if let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            let p = (env["payload"] as? [String: Any]) ?? env
            let body = (p["body"] as? String) ?? ""
            guard !body.isEmpty else { return nil }
            return NotificationEvent(
                body: body,
                channel: p["channel"] as? String,
                title: p["title"] as? String,
                emoji: p["emoji"] as? String,
                receivedAt: Date()
            )
        }
        return nil
    }
}
