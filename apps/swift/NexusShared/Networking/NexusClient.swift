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
import OSLog

/// PTY WebSocket transport logger (nx-gsk4h). `process:nexus` filter in
/// Console.app surfaces the open → replay_done → close lifecycle.
private let ptyLog = Logger(
    subsystem: "dev.leonardoacosta.nexus.mac",
    category: "NexusClient.pty"
)

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

    /// `GET /wave-plans/active` — projection of the in-flight `/apply` or
    /// `/apply:all` wave plan (added by specs-tab-accordion-with-topology).
    ///
    /// Returns:
    /// - `nil` on transport error / non-200 status (caller treats as
    ///   "fetch failed" — the dashboard simply hides wave chips).
    /// - The fully-populated empty payload (`runId == nil`,
    ///   `specStatuses == []`) when no /apply is currently active. This
    ///   lets the consumer distinguish "fetched, no active run" from
    ///   "fetch failed" via `isActive`.
    ///
    /// One-shot HTTP call against `session` (NOT `streamingSession`) —
    /// the agent emits a small static JSON object, no streaming.
    public func fetchWavePlanStatus() async -> WavePlanStatus? {
        let url = endpoint.baseURL.appendingPathComponent("wave-plans/active")
        do {
            let payload: WavePlanStatus = try await getJSON(url: url)
            return payload
        } catch {
            return nil
        }
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

    /// `GET /specs/{project}/{name}/{file}` — raw markdown content for a
    /// single spec document. `file` MUST be one of "proposal", "design",
    /// "tasks". Returns `nil` on 404 (file/spec/project absent); throws on
    /// transport error or non-200/404 status.
    ///
    /// Spec: dashboard-ui-pass-v1 (task 2.1) — backs SpecDetailView's
    /// markdown fetch on selection change.
    public func fetchSpecContent(
        project: String,
        name: String,
        file: String
    ) async throws -> String? {
        let url = endpoint.baseURL
            .appendingPathComponent("specs")
            .appendingPathComponent(project)
            .appendingPathComponent(name)
            .appendingPathComponent(file)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("text/markdown", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        if http.statusCode == 404 { return nil }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        return String(data: data, encoding: .utf8) ?? ""
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

    // MARK: - session-start + spec linkage (specs-tab-start-on-spec)

    /// Response from `POST /session/start`. `specLinked` / `specLinkError`
    /// are populated ONLY when the caller passed `specSlug`; the agent
    /// omits them otherwise.
    public struct SessionStartResponse: Decodable, Sendable {
        public var sessionName: String
        public var started: Bool
        public var sessionId: String?
        public var pid: Int?
        public var specLinked: Bool?
        public var specLinkError: String?

        public enum CodingKeys: String, CodingKey {
            case sessionName = "session_name"
            case started
            case sessionId = "session_id"
            case pid
            case specLinked = "spec_linked"
            case specLinkError = "spec_link_error"
        }
    }

    /// `POST /session/start` — spawn a new Claude Code session in a tmux
    /// window owned by this agent. When `specSlug` is non-nil the agent
    /// also inserts a `spec_sessions` link row so the dashboard can
    /// surface the session under its proposal row.
    ///
    /// The link insert is best-effort on the server: a failure surfaces
    /// as `specLinked: false` + `specLinkError` rather than a non-2xx
    /// response. The tmux window is created either way.
    public func startSession(
        project: String,
        path: String,
        specSlug: String? = nil
    ) async throws -> SessionStartResponse {
        let url = endpoint.baseURL.appendingPathComponent("session/start")
        var body: [String: Any] = ["project": project, "path": path]
        if let specSlug, !specSlug.isEmpty {
            body["spec_slug"] = specSlug
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try decoder.decode(SessionStartResponse.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    /// `GET /specs/{project}/{name}/sessions` — every session (live +
    /// historical) linked to this spec. Returned newest-first.
    public func listSpecSessions(
        project: String,
        name: String
    ) async throws -> [SpecSession] {
        let url = endpoint.baseURL
            .appendingPathComponent("specs")
            .appendingPathComponent(project)
            .appendingPathComponent(name)
            .appendingPathComponent("sessions")
        let envelope: SpecSessionsResponse = try await getJSON(url: url)
        return envelope.sessions
    }

    /// `PATCH /specs/{project}/{name}/status` — flip frontmatter status
    /// between `draft` and `approved`. Throws `NexusClientError.badStatus`
    /// on non-2xx; in particular `409` means the spec is archived
    /// (read-only) and the caller should disable the toggle.
    @discardableResult
    public func patchSpecStatus(
        project: String,
        name: String,
        status: String
    ) async throws -> Data {
        let url = endpoint.baseURL
            .appendingPathComponent("specs")
            .appendingPathComponent(project)
            .appendingPathComponent(name)
            .appendingPathComponent("status")
        var req = URLRequest(url: url)
        req.httpMethod = "PATCH"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["status": status]
        )
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        return data
    }

    /// `GET /credentials` — list every CC profile the agent currently manages.
    /// Returns the flat profile array; callers needing the active fingerprint
    /// hit `fetchCredentialsEnvelope()` instead.
    ///
    /// `dedupe = true` flips on `?dedupe=true`, collapsing duplicate-token
    /// rows to their primary with `siblingCount` + `siblingIds` populated
    /// (added by credentials-account-resolve-and-usage). Default `false`
    /// preserves byte-for-byte legacy behaviour.
    public func fetchCredentials(dedupe: Bool = false) async throws -> [CcProfile] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("credentials"),
            resolvingAgainstBaseURL: false
        )!
        if dedupe {
            comps.queryItems = [URLQueryItem(name: "dedupe", value: "true")]
        }
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        let envelope: CredentialListResponse = try await getJSON(url: url)
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

    /// `POST /credentials/:id/refresh-identity` — manually re-probe a single
    /// credential's /api/oauth/profile and persist the new identity fields.
    /// Returns the updated identity object on 200, throws on transport or
    /// non-2xx status so the UI can surface the failure.
    ///
    /// Added by credentials-account-resolve-and-usage; backs the dashboard's
    /// per-row refresh button on rows where `accountEmail == nil`.
    public struct CredentialIdentityResponse: Decodable, Sendable {
        public var accountEmail: String?
        public var accountName: String?
        public var accountUuid: String?
        public var orgName: String?
        public var orgUuid: String?
    }

    public func refreshCredentialIdentity(
        id: String
    ) async throws -> CredentialIdentityResponse {
        let escaped = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        let url = endpoint.baseURL
            .appendingPathComponent("credentials")
            .appendingPathComponent(escaped)
            .appendingPathComponent("refresh-identity")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try decoder.decode(CredentialIdentityResponse.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    /// `POST /credentials/refresh-identity-all` — bulk re-probe every
    /// credential whose `account_email` is null. Returns the per-batch
    /// summary `{ probed, succeeded, failed }` so the UI can render a
    /// toast on completion. Throws on transport / non-2xx.
    public struct CredentialIdentityBatchResponse: Decodable, Sendable {
        public var probed: Int
        public var succeeded: Int
        public var failed: Int
    }

    public func refreshAllCredentialIdentities()
        async throws -> CredentialIdentityBatchResponse
    {
        let url = endpoint.baseURL
            .appendingPathComponent("credentials")
            .appendingPathComponent("refresh-identity-all")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try decoder.decode(
                CredentialIdentityBatchResponse.self,
                from: data
            )
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    /// `GET /failures?days=N` — recent script + notification failures.
    /// `limit` constrains the rendered top-N (server may return more).
    public func fetchScriptErrors(limit: Int = 50, days: Int = 7) async throws -> [ScriptError] {
        let envelope = try await fetchFailuresEnvelope(days: days)
        let sorted = envelope.topErrors.sorted { $0.capturedAt > $1.capturedAt }
        return Array(sorted.prefix(limit))
    }

    /// `GET /failures?days=N` — full envelope including `byTool`, `byProject`,
    /// `trend`, `source`, `parseErrors`. Used by the FailuresView header to
    /// render filter chips + the trend indicator.
    ///
    /// Spec: openspec/changes/failures-investigation-and-surface (task 1.8)
    public func fetchFailuresEnvelope(days: Int = 7) async throws -> FailuresResponse {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("failures"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "days", value: String(days))]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        return try await getJSON(url: url)
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

    /// `GET /health/processes?limit=N` — top CPU / RAM process snapshot from
    /// the collector cache (no recomputation per request). Added by
    /// `health-tab-process-view`. `limit` is clamped to 1...50 client-side
    /// before being sent; the agent enforces the same range and returns
    /// 400 on violations (caller surfaces via `NexusClientError.badStatus`).
    ///
    /// `machine` is reserved for the agent-aggregate fan-out and is currently
    /// unused on the single-endpoint client; the parameter is here so the
    /// signature lines up with the aggregate-client wrapper.
    public func fetchHealthProcesses(
        machine: String? = nil,
        limit: Int = 10
    ) async throws -> HealthProcessesResponse {
        let clamped = max(1, min(50, limit))
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("health/processes"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = [
            URLQueryItem(name: "limit", value: String(clamped))
        ]
        if let machine, !machine.isEmpty {
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

    /// `GET /notifications/:id/audio` — stream the cached MP3 for a
    /// notification (notifications-overhaul, task 3.2). Returns the
    /// full bytes in one `AsyncThrowingStream` chunk; downstream players
    /// (AVAudioPlayer) buffer the whole body before playback. Throws
    /// `NexusClientError.badStatus(404|410|...)` so the caller can
    /// distinguish "never synthesised" (404) from "pruned" (410) from
    /// transport failure.
    public func streamNotificationAudio(
        id: String
    ) -> AsyncThrowingStream<Data, Error> {
        let endpoint = self.endpoint
        let streamingSession = self.streamingSession
        return AsyncThrowingStream { continuation in
            let escaped = id.addingPercentEncoding(
                withAllowedCharacters: .urlPathAllowed
            ) ?? id
            let url = endpoint.baseURL
                .appendingPathComponent("notifications")
                .appendingPathComponent(escaped)
                .appendingPathComponent("audio")
            var req = URLRequest(url: url)
            req.httpMethod = "GET"
            req.addValue("audio/mpeg", forHTTPHeaderField: "Accept")
            Task {
                do {
                    let (data, response) = try await streamingSession.data(for: req)
                    if let http = response as? HTTPURLResponse,
                       !(200...299).contains(http.statusCode) {
                        continuation.finish(
                            throwing: NexusClientError.badStatus(http.statusCode)
                        )
                        return
                    }
                    continuation.yield(data)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: NexusClientError.transport(error))
                }
            }
        }
    }

    /// `GET /notifications/voices` — fetch the project -> voiceId mapping
    /// (notifications-overhaul, task 3.2). Returns an empty dictionary on
    /// no rows; throws on transport / non-2xx.
    public func fetchProjectVoices() async throws -> [String: String] {
        let url = endpoint.baseURL.appendingPathComponent("notifications/voices")
        return try await getJSON(url: url)
    }

    /// `PUT /notifications/voices/:project` — upsert a voice override.
    /// Returns the persisted row on 200; throws on transport / non-2xx.
    public struct ProjectVoiceResponse: Decodable, Sendable {
        public var project: String
        public var voice_id: String
        public var updated_at: String
    }

    @discardableResult
    public func putProjectVoice(
        project: String,
        voiceId: String
    ) async throws -> ProjectVoiceResponse {
        let escaped = project.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? project
        let url = endpoint.baseURL
            .appendingPathComponent("notifications/voices")
            .appendingPathComponent(escaped)
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["voice_id": voiceId]
        )
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try decoder.decode(ProjectVoiceResponse.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    /// `DELETE /notifications/voices/:project` — drop the override.
    /// 204 on success (also 204 when the row didn't exist; idempotent).
    /// Throws on transport or other non-2xx status.
    public func deleteProjectVoice(project: String) async throws {
        let escaped = project.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? project
        let url = endpoint.baseURL
            .appendingPathComponent("notifications/voices")
            .appendingPathComponent(escaped)
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let response: URLResponse
        do {
            (_, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
    }

    /// `POST /commands/send-text` — forward keystrokes into the session's
    /// tmux pane. Used by the macOS dashboard's PTY viewer to attach
    /// bidirectionally (read stream + write keystrokes) on managed sessions.
    ///
    /// Spec: openspec/changes/session-attach-and-cwd-cap (task 2.1)
    /// Agent route: apps/agent/src/routes/commands-send-text.ts
    ///
    /// Uses `session` (NOT `streamingSession`) — this is a one-shot POST.
    /// Throws `NexusClientError.badStatus(...)` on non-2xx so the caller can
    /// surface "session vanished" (404) or "agent rejected the keys" (400/500)
    /// distinctly from a successful send.
    public func sendText(sessionId: String, text: String) async throws {
        let url = endpoint.baseURL.appendingPathComponent("commands/send-text")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["sessionId": sessionId, "text": text]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        _ = data
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
    }

    /// Consume `GET /sessions/{id}/stream` — agent PTY byte stream. The
    /// handler receives raw PTY bytes; callers feed them into a terminal
    /// emulator (SwiftTerm) for rendering.
    ///
    /// Transport (nx-gsk4h): the agent serves `/sessions/{id}/stream` as a
    /// **WebSocket-only** endpoint (`apps/agent/src/terminal/stream-manager.ts`).
    /// A plain `GET` with `Accept: text/event-stream` returns 500
    /// "WebSocket upgrade failed", so this SSE consumer cannot actually attach
    /// — the PtyViewer flips to `.disconnected`. KNOWN LIMITATION: a proper
    /// `URLSessionWebSocketTask` client is needed, but the first attempt
    /// crashed the app (uncatchable ObjC NSException from `webSocketTask(with:)`
    /// on macOS 26.3). Reverted to SSE to keep the app stable; the WebSocket
    /// re-attempt is tracked in nx-gsk4h. Until then, PTY terminal attach is
    /// non-functional (everything else — sessions list, TTS, banner — works).
    public func consumePtyStream(
        sessionId: String,
        handler: @Sendable @escaping (Data) async -> Void
    ) async throws {
        let url = endpoint.baseURL
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("stream")

        // REVERTED to SSE 2026-05-24 (nx-gsk4h): the URLSessionWebSocketTask
        // rewrite crashed the app — `webSocketTask(with:)` raises an
        // UNCATCHABLE ObjC NSException on macOS 26.3 (`.infinity` request
        // timeout was ruled out as the cause; the leading hypothesis is the
        // endpoint's `http://` scheme being rejected — `webSocketTask` may
        // require `ws://`/`wss://` on this OS). Swift `try/catch` cannot trap
        // an ObjC exception, so the `NexusAggregateClient.multiplex` fan-out
        // aborted the whole process. SSE hits the WS-only agent endpoint and
        // gets HTTP 500, so PTY shows `.disconnected` (no terminal attach) —
        // but the app STAYS UP. The proper WebSocket client (scheme fix +
        // isolated runtime verification) is re-attempted under nx-gsk4h.
        try await SSEDecoder.consume(
            url: url,
            session: streamingSession
        ) { event in
            if let data = event.data.data(using: .utf8) {
                await handler(data)
            }
        }
    }

    // MARK: - Lifecycle

    /// Drop in-flight transport before the owning aggregate replaces this
    /// client (settings-tab-redesign / agents.toml rebootstrap, bd:nx-ymz1v).
    /// Best-effort — invalidation cancels outstanding tasks; subsequent
    /// callers on a retired client will see `NexusClientError.transport`.
    public func invalidateSessions() {
        session.invalidateAndCancel()
        streamingSession.invalidateAndCancel()
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
