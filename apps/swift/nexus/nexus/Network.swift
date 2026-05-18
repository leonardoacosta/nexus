//
//  Network.swift
//  nexus
//
//  Tiny request helpers built on URLSession. All endpoints are loopback /
//  Tailscale-local — auth was dropped per `drop-attach-secret-gate`.
//
//  NexusShared migration (nx-4roof): SSE decoding moved to
//  `NexusShared.SSEDecoder` + `NexusShared.SSEEvent`. The per-event payload
//  extensions (`decodeSession`, `decodeSessionId`, `decodeHeartbeatMetrics`,
//  `decodeNotification`) ship on `NexusShared.SSEEvent`. This file now only
//  exposes the HTTP request helpers `NexusViewModel` and `SpawnHomelabSession`
//  still call directly; the streaming `URLSession` (`Network.streamingSession`)
//  is reused by callers that hand it to `SSEDecoder.consume(url:session:…)`.
//

import Foundation
import NexusShared

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
    /// Handed to `NexusShared.SSEDecoder.consume(url:session:handler:)`.
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
