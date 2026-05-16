//
//  Network.swift
//  nexus
//
//  Tiny request helpers + an SSE consumer built on URLSession.bytes(for:).
//  All endpoints are loopback / Tailscale-local — auth was dropped per
//  `drop-attach-secret-gate`.
//

import Foundation

enum NetworkError: Error {
    case badStatus(Int)
    case decoding(Error)
    case transport(Error)
}

enum Network {
    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    /// Streaming session reused for SSE — kept separate so connection reuse
    /// doesn't pin a long-lived stream to the same socket as one-shot GETs.
    static let streamingSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = .infinity
        cfg.timeoutIntervalForResource = .infinity
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: cfg)
    }()

    static let jsonDecoder: JSONDecoder = {
        let d = JSONDecoder()
        // Per-type custom decoders handle the date forms — don't set a global
        // strategy that would conflict.
        return d
    }()

    @discardableResult
    static func getJSON<T: Decodable>(url: URL) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NetworkError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw NetworkError.badStatus(http.statusCode)
        }
        do {
            return try jsonDecoder.decode(T.self, from: data)
        } catch {
            throw NetworkError.decoding(error)
        }
    }

    @discardableResult
    static func postJSON(url: URL, body: [String: Any]) async -> Data? {
        await send(method: "POST", url: url, body: body)
    }

    @discardableResult
    static func patchJSON(url: URL, body: [String: Any]) async -> Data? {
        await send(method: "PATCH", url: url, body: body)
    }

    @discardableResult
    private static func send(method: String, url: URL, body: [String: Any]) async -> Data? {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await session.data(for: req)
            return data
        } catch {
            return nil
        }
    }
}

// MARK: - SSE

/// A decoded Server-Sent Events frame. The agent emits frames as
/// `event: <name>\ndata: <json>\n\n` (see apps/agent/src/routes/events-sse.ts).
struct SSEEvent: Equatable, Sendable {
    var name: String
    var data: String
}

extension SSEEvent {
    /// The agent's `LifecycleEnvelope<TEvent>` shape carries the event-specific
    /// payload under either `payload` or top-level keys depending on the
    /// emitter. We probe both.
    private struct RawEnvelope: Decodable {
        let event: String?
        let type: String?
        let timestamp: String?
        let payload: JSONValue?
        let session: JSONValue?
        let sessionId: String?
        let cpu_percent: Double?
        let ram_percent: Double?
        let body: String?
        let channel: String?
        let title: String?
        let emoji: String?
    }

    private var envelope: RawEnvelope? {
        guard let payload = data.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(RawEnvelope.self, from: payload)
    }

    /// Parse a `RemoteSessionStarted` envelope. The lifecycle bus serializes
    /// the new session under either `payload.session` (preferred) or directly
    /// on the envelope. We accept both.
    func decodeSession() -> NexusSession? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        // Probe nested forms first.
        if let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            if let session = env["session"] as? [String: Any],
               let nested = try? JSONSerialization.data(withJSONObject: session),
               let row = try? Network.jsonDecoder.decode(NexusSession.self, from: nested) {
                return row
            }
            if let payload = env["payload"] as? [String: Any],
               let session = payload["session"] as? [String: Any],
               let nested = try? JSONSerialization.data(withJSONObject: session),
               let row = try? Network.jsonDecoder.decode(NexusSession.self, from: nested) {
                return row
            }
            // Fallback: envelope IS the session.
            if let row = try? Network.jsonDecoder.decode(NexusSession.self, from: bytes) {
                return row
            }
        }
        return nil
    }

    func decodeSessionId() -> String? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        if let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            if let id = env["sessionId"] as? String { return id }
            if let id = env["id"] as? String { return id }
            if let p = env["payload"] as? [String: Any],
               let id = p["sessionId"] as? String ?? p["id"] as? String {
                return id
            }
        }
        return nil
    }

    func decodeHeartbeatMetrics() -> (cpu: Double?, ram: Double?) {
        let env = envelope
        if let cpu = env?.cpu_percent ?? env?.payload?.value(forKey: "cpu_percent") as? Double,
           let ram = env?.ram_percent ?? env?.payload?.value(forKey: "ram_percent") as? Double {
            return (cpu, ram)
        }
        return (env?.cpu_percent, env?.ram_percent)
    }

    func decodeNotification() -> NotificationEvent? {
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

/// Tiny JSON probe wrapper — lets us peek into `payload: any` without forcing
/// every event type into its own Codable struct.
struct JSONValue: Decodable {
    let raw: Any?

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { raw = nil }
        else if let v = try? c.decode(Bool.self) { raw = v }
        else if let v = try? c.decode(Double.self) { raw = v }
        else if let v = try? c.decode(String.self) { raw = v }
        else if let v = try? c.decode([JSONValue].self) {
            raw = v.map { $0.raw } as [Any?]
        }
        else if let v = try? c.decode([String: JSONValue].self) {
            var dict: [String: Any?] = [:]
            for (k, jv) in v { dict[k] = jv.raw }
            raw = dict
        } else { raw = nil }
    }

    func value(forKey key: String) -> Any? {
        (raw as? [String: Any?])?[key] ?? nil
    }
}

enum SSE {
    /// Consume an SSE endpoint, invoking `handler` for each `event:`-named frame.
    /// Throws on transport failure (the caller is responsible for reconnect).
    static func consume(
        url: URL,
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = TimeInterval.infinity

        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await Network.streamingSession.bytes(for: req)
        } catch {
            throw NetworkError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw NetworkError.badStatus(http.statusCode)
        }

        var currentEvent: String?
        var currentData = ""
        for try await line in bytes.lines {
            if line.isEmpty {
                // Dispatch the frame.
                if let name = currentEvent, !currentData.isEmpty {
                    await handler(SSEEvent(name: name, data: currentData))
                } else if !currentData.isEmpty {
                    // Comment-only or unnamed — treat as a message frame.
                    await handler(SSEEvent(name: "message", data: currentData))
                }
                currentEvent = nil
                currentData = ""
                continue
            }
            if line.hasPrefix(":") { continue } // comment / keepalive
            if line.hasPrefix("event:") {
                currentEvent = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let chunk = line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
                if currentData.isEmpty { currentData = chunk }
                else { currentData += "\n" + chunk }
            }
            // Other field names ("id:", "retry:") ignored — agent doesn't emit them.
        }
        // Stream ended.
    }
}
