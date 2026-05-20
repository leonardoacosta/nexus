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
    public static func consume(
        url: URL,
        session: URLSession,
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = TimeInterval.infinity

        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await session.bytes(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw NexusClientError.badStatus(http.statusCode)
        }
        sseLogger.info("SSEDecoder: connected url=\(url.absoluteString, privacy: .public)")

        var currentEvent: String?
        var currentData = ""
        for try await line in bytes.lines {
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
