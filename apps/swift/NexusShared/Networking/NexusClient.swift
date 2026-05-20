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

    /// Endpoint actually used by clients. INTERIM (nx-4ohfs): reads a
    /// single-endpoint override from `SettingsStore.dashboardEndpoint`
    /// (UserDefaults key `nexus.dashboard.endpoint`). When the local Mac
    /// agent is down, this lets the dashboard talk to a healthy peer
    /// (e.g. homelab over Tailscale) without per-view edits. Falls back to
    /// `.localhost` when unset or unparseable.
    /// TODO(nx-4ohfs): replace with agents.toml-driven multi-agent
    /// aggregation (the Swift-side replacement for the deleted
    /// peer-connector federation). This static collapses to the
    /// "primary agent" once that lands.
    public static var resolved: NexusEndpoint {
        if let raw = SettingsStore.shared.dashboardEndpoint,
           !raw.isEmpty,
           let url = URL(string: raw) {
            return NexusEndpoint(baseURL: url)
        }
        return .localhost
    }
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

    // INTERIM (nx-4ohfs): default flipped .localhost -> .resolved so all
    // dashboard views + SessionObserver honor the endpoint override
    // transparently. Explicit `init(endpoint:)` callers (iOS/watch) are
    // unaffected.
    public init(endpoint: NexusEndpoint = .resolved) {
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

    /// `PATCH /projects/:id` — set/clear the persisted `hidden` flag on a
    /// project so the user can prune a discovered project (the auto-discovery
    /// scanner keeps `hidden=true` sticky across re-scans).
    ///
    /// `id` is the project's registry UUID (`projects.id`). `GET /projects`
    /// now surfaces this as `ProjectAggregate.projectID` (registry-backed rows
    /// only; session-only buckets carry `nil` and the UI hides the affordance),
    /// so callers pass the real UUID and the agent route
    /// (`apps/agent/src/routes/projects.ts` `handleUpdateProject`) accepts it.
    /// The id-exposure gap (E2E task 4.2 / nx-3ynb9) is closed end-to-end.
    ///
    /// Returns the raw response body (best-effort; nil on transport failure).
    @discardableResult
    public func patchProject(id: String, hidden: Bool) async -> Data? {
        let escaped = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        return await send(
            method: "PATCH",
            url: endpoint.baseURL
                .appendingPathComponent("projects")
                .appendingPathComponent(escaped),
            body: ["hidden": hidden]
        )
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

    /// `GET /projects` — aggregated projects across known machines.
    /// Without pagination params this returns a bare `[ProjectAggregate]`.
    public func fetchProjects() async throws -> [ProjectAggregate] {
        let url = endpoint.baseURL.appendingPathComponent("projects")
        return try await getJSON(url: url)
    }

    /// `GET /specs[?status=…&project=…]` — list specs across all projects.
    public func fetchSpecs(
        status: String? = nil,
        project: String? = nil
    ) async throws -> [SpecSummary] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("specs"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = []
        if let status { items.append(URLQueryItem(name: "status", value: status)) }
        if let project { items.append(URLQueryItem(name: "project", value: project)) }
        if !items.isEmpty { comps.queryItems = items }
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        return try await getJSON(url: url)
    }

    /// Consume `GET /specs/events`, invoking `handler` per SpecTransition.
    public func consumeSpecEvents(
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async throws {
        let url = endpoint.baseURL.appendingPathComponent("specs/events")
        try await SSEDecoder.consume(
            url: url,
            session: streamingSession,
            handler: handler
        )
    }

    /// `GET /credentials` — list every CC profile the agent currently manages.
    /// Returns the flat profile array; callers needing the active fingerprint
    /// hit `fetchCredentialsEnvelope()` instead.
    public func fetchCredentials() async throws -> [CcProfile] {
        let envelope: CredentialListResponse = try await getJSON(
            url: endpoint.baseURL.appendingPathComponent("credentials")
        )
        // Stamp `isActive` so the UI doesn't need to thread the fingerprint.
        let active = envelope.activeFingerprint
        return envelope.credentials.map { profile in
            var p = profile
            if let active, profile.fingerprint == active { p = p.markActive() }
            return p
        }
    }

    /// `GET /credentials` — full envelope including `activeFingerprint`.
    public func fetchCredentialsEnvelope() async throws -> CredentialListResponse {
        try await getJSON(url: endpoint.baseURL.appendingPathComponent("credentials"))
    }

    /// `GET /failures?days=N` — recent script + notification failures.
    /// `limit` constrains the rendered top-N (server may return more).
    public func fetchScriptErrors(limit: Int = 50, days: Int = 7) async throws -> [ScriptError] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("failures"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "days", value: String(days))]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        let envelope: FailuresResponse = try await getJSON(url: url)
        let sorted = envelope.topErrors.sorted { $0.capturedAt > $1.capturedAt }
        return Array(sorted.prefix(limit))
    }

    /// `GET /health/history?hours=N&machine=…` — per-machine sparkline rows.
    /// `since` is converted to an `hours` window the agent already understands;
    /// `machine` is reserved for the multi-machine endpoint shipping under
    /// retire-web-dashboard-infra.
    public func fetchHealthSeries(machine: String = "", since: Date) async throws -> [HealthSnapshot] {
        let elapsed = max(0.01, Date().timeIntervalSince(since) / 3600.0)
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("health/history"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = [
            URLQueryItem(name: "hours", value: String(elapsed))
        ]
        if !machine.isEmpty {
            items.append(URLQueryItem(name: "machine", value: machine))
        }
        comps.queryItems = items
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        return try await getJSON(url: url)
    }

    /// `GET /integrations` — read-only status of every wired integration.
    /// Returns `[]` on 404 so older agents (which only ship per-integration
    /// sub-routes) don't break the dashboard.
    public func fetchIntegrations() async throws -> [IntegrationStatus] {
        let url = endpoint.baseURL.appendingPathComponent("integrations")
        do {
            return try await getJSON(url: url)
        } catch NexusClientError.badStatus(404) {
            return []
        }
    }

    /// `GET /notifications` — historical notification rows persisted by the
    /// agent (severity + delivery_state shipped in agent-payload-completeness).
    /// Returned newest-first by the agent; callers prepend on mount so the
    /// HISTORY sidebar surfaces past rows before live SSE arrives.
    /// nx-9mt43: NotificationsView historical backfill.
    public func fetchNotifications() async throws -> [NotificationEvent] {
        let url = endpoint.baseURL.appendingPathComponent("notifications")
        return try await getJSON(url: url)
    }

    /// Consume `GET /events/stream` and filter for `NotificationFired`
    /// frames client-side via `decodeNotification()`. Invokes `handler`
    /// per decoded NotificationEvent. (The agent does not expose a
    /// dedicated `/notifications/stream` endpoint.)
    public func consumeNotifications(
        handler: @Sendable @escaping (NotificationEvent) async -> Void
    ) async throws {
        let url = endpoint.baseURL.appendingPathComponent("events/stream")
        try await SSEDecoder.consume(
            url: url,
            session: streamingSession
        ) { event in
            // Server may emit a typed envelope (event: NotificationFired) or
            // raw `message`-style frames; decodeNotification() handles both.
            if let n = event.decodeNotification() {
                await handler(n)
            }
        }
    }

    /// Consume `GET /sessions/{id}/stream` — agent PTY byte stream. The
    /// handler receives raw bytes (post-SSE-frame, pre-ANSI). Callers feed
    /// the bytes into a terminal emulator (SwiftTerm) for rendering.
    public func consumePtyStream(
        sessionId: String,
        handler: @Sendable @escaping (Data) async -> Void
    ) async throws {
        let url = endpoint.baseURL
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("stream")
        try await SSEDecoder.consume(
            url: url,
            session: streamingSession
        ) { event in
            if let data = event.data.data(using: .utf8) {
                await handler(data)
            }
        }
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
