// NexusClient — HTTP fetcher + SSE subscriber for the agent API.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.3)
//
// Loopback / Tailscale-local — no auth (dropped per drop-attach-secret-gate).
// Per-target endpoints are configured via NexusEndpoint.
//
// The pre-NexusShared `NexusClient` (apps/swift/nexus/nexus/NexusClient.swift)
// was an actor that owned canonical state AND owned the network layer. Here
// we split: NexusClient handles transport only (typed HTTP + SSE), and the
// state actor lives in Observers/SessionObserver.swift.

import Foundation

/// Where to reach the agent. Default points at loopback; iOS / watchOS clients
/// override via `NexusClient.init(endpoint:)` to hit `homelab:7400` over the
/// Tailnet.
public struct NexusEndpoint: Sendable {
    public var baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    public static let localhost = NexusEndpoint(
        baseURL: URL(string: "http://localhost:7400")!
    )
}

public enum NexusClientError: Error {
    case badStatus(Int)
    case decoding(Error)
    case transport(Error)
}

public actor NexusClient {
    public let endpoint: NexusEndpoint

    private let session: URLSession
    private let streamingSession: URLSession
    private let decoder: JSONDecoder

    public init(endpoint: NexusEndpoint = .localhost) {
        self.endpoint = endpoint

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: cfg)

        let streamCfg = URLSessionConfiguration.default
        streamCfg.timeoutIntervalForRequest = .infinity
        streamCfg.timeoutIntervalForResource = .infinity
        streamCfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        streamCfg.httpMaximumConnectionsPerHost = 4
        self.streamingSession = URLSession(configuration: streamCfg)

        self.decoder = JSONDecoder()
    }

    // MARK: - HTTP fetchers

    /// `GET /sessions?withFingerprint=true` — only fingerprinted CC rows.
    public func fetchSessions(withFingerprint: Bool = true) async throws -> [Session] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("sessions"),
            resolvingAgainstBaseURL: false
        )
        if withFingerprint {
            comps?.queryItems = [URLQueryItem(name: "withFingerprint", value: "true")]
        }
        guard let url = comps?.url else { throw NexusClientError.badStatus(0) }
        return try await getJSON(url: url)
    }

    /// `GET /health/history?hours=N` — sparkline-ready samples.
    public func fetchHealthHistory(hours: Double = 0.167) async throws -> [HealthSnapshot] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("health/history"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "hours", value: String(hours))]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        return try await getJSON(url: url)
    }

    /// `PATCH /notifications/settings` — toggle TTS / provider / etc.
    @discardableResult
    public func patchNotificationSettings(_ body: [String: Any]) async -> Data? {
        await send(method: "PATCH",
                   url: endpoint.baseURL.appendingPathComponent("notifications/settings"),
                   body: body)
    }

    /// `POST /notifications/send` — fire a test notification or replay one.
    @discardableResult
    public func postNotification(_ body: [String: Any]) async -> Data? {
        await send(method: "POST",
                   url: endpoint.baseURL.appendingPathComponent("notifications/send"),
                   body: body)
    }

    // MARK: - SSE stream

    /// Consume `GET /events/stream`, invoking `handler` per decoded frame.
    /// Throws on transport / status failure — caller manages reconnect.
    public func consumeEvents(
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async throws {
        let url = endpoint.baseURL.appendingPathComponent("events/stream")
        try await SSEDecoder.consume(
            url: url,
            session: streamingSession,
            handler: handler
        )
    }

    // MARK: - Helpers

    private func getJSON<T: Decodable>(url: URL) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    @discardableResult
    private func send(method: String, url: URL, body: [String: Any]) async -> Data? {
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
