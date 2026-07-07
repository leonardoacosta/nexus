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
import Network
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
    /// Streaming SSE consumer saw NO bytes for the idle window (nx-e1j52).
    /// The agent emits a `: keepalive\n\n` comment every 30s, so a silent
    /// stream means the relay is holding a half-open socket to a dead agent.
    /// `SSEDecoder.consume` finishes the stream with this so the
    /// `TTSObserver.reconnectLoop` re-dials instead of blocking forever.
    case idleTimeout
}

/// Wire envelope for `GET /thread` — `{ "messages": [...] }`. A missing
/// `messages` key (or empty body) decodes to an empty array so `fetchThread`
/// degrades to `[]` instead of throwing.
struct ThreadEnvelope: Decodable {
    let messages: [CommsMessage]

    enum CodingKeys: String, CodingKey { case messages }

    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        self.messages = (try? c?.decode([CommsMessage].self, forKey: .messages)) ?? []
    }
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

    /// `GET /thread?source=<src>&id=<coreId>` — the on-demand conversation
    /// thread for one comms item, oldest -> newest. The mesh wraps the rows in
    /// `{ "messages": [...] }`. A 404 (source has no thread endpoint yet) or an
    /// absent/empty body resolves to `[]` so the caller renders an empty state
    /// rather than surfacing an error — every source's thread is best-effort.
    public func fetchThread(source: String, id: String) async throws -> [CommsMessage] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("thread"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [
            URLQueryItem(name: "source", value: source),
            URLQueryItem(name: "id", value: id),
        ]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        do {
            let envelope: ThreadEnvelope = try await getJSON(url: url)
            return envelope.messages
        } catch NexusClientError.badStatus(404) {
            return []
        }
    }

    /// `PATCH /notifications/settings` — toggle TTS / provider / etc.
    @discardableResult
    public func patchNotificationSettings(_ body: [String: Any]) async -> Data? {
        await send(method: "PATCH",
                   url: endpoint.baseURL.appendingPathComponent("notifications/settings"),
                   body: body)
    }

    // MARK: - Presence reporting (mac-presence-observer, nx-kyrwi)

    /// `POST /presence/report` — push a presence delta from the local Mac
    /// sensor (`nexus-presence` LaunchAgent). `body` is the non-nil subset of a
    /// `PresenceDelta` (camelCase keys the agent's `presence-report` route
    /// accepts: macActive / macLocked / macHost / inMeeting / macIdleSec /
    /// macFocus / homeHint). Best-effort: returns the raw response body, or nil
    /// on transport failure — the sensor logs + retries on the next delta.
    @discardableResult
    public func reportPresence(_ body: [String: Any]) async -> Data? {
        await send(method: "POST",
                   url: endpoint.baseURL.appendingPathComponent("presence/report"),
                   body: body)
    }

    // MARK: - Presence routing (context-aware-routing, nx-rwulm)

    /// Wire echo of `GET|PATCH /notifications/settings` (the presence-routing
    /// subset). snake_case keys decode straight off the agent's response.
    public struct NotificationSettingsResponse: Decodable, Sendable {
        public var presenceAwareRouting: Bool
        public var unknownNoncriticalMode: PresenceFailMode
        public var unknownCriticalMode: PresenceFailMode
        /// ios-presence-reporter (Phase 2): the bedtime-sources policy
        /// (`hk|focus|either|both`). Defaults to `either` when absent.
        public var bedtimeSources: BedtimeSources

        public enum CodingKeys: String, CodingKey {
            case presenceAwareRouting = "presence_aware_routing"
            case unknownNoncriticalMode = "unknown_noncritical_mode"
            case unknownCriticalMode = "unknown_critical_mode"
            case bedtimeSources = "bedtime_sources"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.presenceAwareRouting =
                (try? c.decode(Bool.self, forKey: .presenceAwareRouting)) ?? false
            self.unknownNoncriticalMode =
                (try? c.decode(PresenceFailMode.self, forKey: .unknownNoncriticalMode)) ?? .failSafe
            self.unknownCriticalMode =
                (try? c.decode(PresenceFailMode.self, forKey: .unknownCriticalMode)) ?? .failOpen
            self.bedtimeSources =
                (try? c.decode(BedtimeSources.self, forKey: .bedtimeSources)) ?? .either
        }
    }

    /// `GET /notifications/settings` — typed read of the presence-routing
    /// subset (the Routing pane reads this on appear to reflect a fleet-peer
    /// edit that arrived via `SettingsChanged`). Returns `nil` on transport /
    /// non-2xx so the pane keeps its last-known-good UserDefaults copy.
    public func fetchNotificationSettings() async -> NotificationSettingsResponse? {
        let url = endpoint.baseURL.appendingPathComponent("notifications/settings")
        return try? await getJSON(url: url)
    }

    // MARK: - Fleet presence (cross-machine-delivery, nx-ewwvq)

    /// `GET /presence/fleet` — the dashboard's fleet-presence view: every
    /// `fleet_presence` row, the resolved live-console machine, and the local
    /// machine name (apps/agent/src/routes/presence-fleet.ts).
    ///
    /// Returns `nil` on transport / non-2xx / decode failure so the
    /// `FleetPresenceIndicator` keeps its last-known-good snapshot (or renders
    /// its empty state on first load) rather than surfacing an error — the
    /// indicator is best-effort ambient context, not a critical path.
    public func fetchFleetPresence() async -> FleetPresenceResponse? {
        let url = endpoint.baseURL.appendingPathComponent("presence/fleet")
        return try? await getJSON(url: url)
    }

    /// Wire shape of one `/notifications/routing-rules` row. `condition` /
    /// `action` are opaque JSON maps the agent round-trips; the Routing pane
    /// works in the richer `RoutingRule` model and only sends id + the flat
    /// predicate/action maps it owns, so reorders persist losslessly.
    public struct RoutingRuleWire: Codable, Sendable {
        public var id: String
        public var priority: Int
        public var condition: [String: Bool]
        public var action: [String: String]
        public var enabled: Bool

        // Explicit public init — the synthesized memberwise init is internal,
        // so cross-module callers (the nexus-mac Routing pane) cannot construct
        // one without this.
        public init(
            id: String,
            priority: Int,
            condition: [String: Bool],
            action: [String: String],
            enabled: Bool
        ) {
            self.id = id
            self.priority = priority
            self.condition = condition
            self.action = action
            self.enabled = enabled
        }
    }

    private struct RoutingRulesEnvelope: Codable, Sendable {
        var rules: [RoutingRuleWire]
    }

    /// `GET /notifications/routing-rules` — rules in `priority` order.
    /// Returns `nil` on transport / non-2xx (pane keeps its local copy);
    /// returns `[]` when the agent has no rules yet.
    public func fetchRoutingRules() async -> [RoutingRuleWire]? {
        let url = endpoint.baseURL.appendingPathComponent("notifications/routing-rules")
        do {
            let env: RoutingRulesEnvelope = try await getJSON(url: url)
            return env.rules
        } catch {
            return nil
        }
    }

    /// `PUT /notifications/routing-rules` — replace the whole rule set. The
    /// array INDEX becomes the persisted `priority`, so a drag-reorder is a
    /// single atomic PUT. Broadcasts `SettingsChanged` server-side. Returns
    /// the persisted body (best-effort; nil on transport failure).
    @discardableResult
    public func putRoutingRules(_ rules: [RoutingRuleWire]) async -> Data? {
        let url = endpoint.baseURL.appendingPathComponent("notifications/routing-rules")
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(RoutingRulesEnvelope(rules: rules))
        do {
            let (data, _) = try await session.data(for: req)
            return data
        } catch {
            return nil
        }
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

    /// `GET /beads/unlinked?project=<code>` — open + in-progress beads with
    /// no proposal link (unplanned work). Returns `[]` on 404 (older agent
    /// without the route) so the Specs tab's "Unlinked" section renders an
    /// empty state instead of surfacing an error.
    ///
    /// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.2)
    public func fetchUnlinkedBeads(project: String) async throws -> [UnlinkedBead] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("beads/unlinked"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "project", value: project)]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        do {
            let envelope: UnlinkedBeadsResponse = try await getJSON(url: url)
            return envelope.unlinked
        } catch NexusClientError.badStatus(404) {
            return []
        }
    }

    /// `GET /roadmap?project=<code>` — `[CAPABILITY]` epics with their child
    /// proposals + per-capability progress. Returns `[]` on 404 (older agent
    /// without the route) so the Roadmap tab shows an empty state rather than
    /// an error.
    ///
    /// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.2)
    public func fetchRoadmap(project: String) async throws -> [RoadmapCapability] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("roadmap"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "project", value: project)]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        do {
            let envelope: RoadmapResponse = try await getJSON(url: url)
            return envelope.capabilities
        } catch NexusClientError.badStatus(404) {
            return []
        }
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

    /// `GET /credentials/:id/usage-history?window=5h|7d&sinceHours=N` — the
    /// ordered utilization series for one account (oldest → newest). Backs the
    /// Mac dashboard's per-row sparkline. `window` selects which of the 5h / 7d
    /// used+limit columns the agent maps onto each point; `sinceHours` is the
    /// lookback. Returns `[]` on a 200 with no rows (unknown id / no history
    /// yet) or a 404 (older agent without the endpoint) so the chart hides its
    /// section instead of surfacing an error.
    ///
    /// Spec: openspec/changes/credential-usage-history (task 3.2) — bd:nx-ffpi8
    public func fetchUsageHistory(
        id: String,
        window: String = "5h",
        sinceHours: Int = 24
    ) async throws -> [UsageHistoryPoint] {
        let escaped = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        var comps = URLComponents(
            url: endpoint.baseURL
                .appendingPathComponent("credentials")
                .appendingPathComponent(escaped)
                .appendingPathComponent("usage-history"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [
            URLQueryItem(name: "window", value: window),
            URLQueryItem(name: "sinceHours", value: String(sinceHours)),
        ]
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
        do {
            let envelope: UsageHistoryResponse = try await getJSON(url: url)
            return envelope.points
        } catch NexusClientError.badStatus(404) {
            return []
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

    /// `GET /sources` — the mx aggregator's source-index payload: the registry
    /// fan-out over mx/v1/source.proto (per-source health + counts + MINE +
    /// capabilities) plus the cross-source MINE inbox preview.
    ///
    /// Spec: mx-bzzb [nx-ui] Shell / source index view (epic mx-rkir).
    ///
    /// ENDPOINT NOT YET SHIPPED (Wave-4): the Nexus agent's source-index
    /// aggregator does not exist at time of writing, so this 404s today. The
    /// view renders graceful empty / error states until it lands (clone of the
    /// HealthView loading pattern); a 404 surfaces an empty `SourceIndex` so
    /// older agents don't hard-fail the dashboard, mirroring `fetchIntegrations`.
    public func fetchSourceIndex() async throws -> SourceIndex {
        let url = endpoint.baseURL.appendingPathComponent("sources")
        do {
            return try await getJSON(url: url)
        } catch NexusClientError.badStatus(404) {
            return SourceIndex(sources: [], inbox: [])
        }
    }

    /// `GET /triage` — the mx aggregator's unified cross-source item feed: the
    /// `Core` spine + `TriagePayload` oneof of five family bodies (comms /
    /// calendar / finance / health / sessions), one `TriageItem` per row.
    ///
    /// Spec: mx-rkir [nx-ui] — the six archetype pages all consume this feed.
    ///
    /// ENDPOINT NOT YET SHIPPED: the Nexus agent's triage aggregator does not
    /// exist at time of writing, so this 404s today. A 404 surfaces an empty
    /// array (mirroring `fetchSourceIndex` / `fetchIntegrations`) so older
    /// agents don't hard-fail the dashboard; the views fall back to
    /// `TriageItem.sampleData` via `TriageObserver` (with an `isSampleData`
    /// caption). `source` / `kind` optionally filter the feed server-side.
    public func fetchTriage(
        source: String? = nil,
        kind: String? = nil
    ) async throws -> [TriageItem] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("triage"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = []
        if let source, !source.isEmpty { items.append(URLQueryItem(name: "source", value: source)) }
        if let kind, !kind.isEmpty { items.append(URLQueryItem(name: "kind", value: kind)) }
        if !items.isEmpty { comps.queryItems = items }
        guard let url = comps.url else { throw NexusClientError.badStatus(0) }
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

    /// `POST /commands/resize` — resize the session's tmux pane to the
    /// viewer's grid (take-over mode). Mirrors `sendText`'s shape: one-shot
    /// POST on `session`, JSON body `{ sessionId, cols, rows }`.
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.2)
    /// Agent route: apps/agent/src/routes/commands-resize.ts —
    /// enforces `sessionType == "managed"` (409 otherwise) and validates
    /// in-range positive dims (400). The Swift toggle is also managed-gated,
    /// so a 409 here is defence-in-depth, not the normal path.
    ///
    /// Throws `NexusClientError.badStatus(409)` when the session is not
    /// managed, `.badStatus(400)` on invalid dims, `.badStatus(404)` when the
    /// session vanished — so the caller can surface the right failure.
    public func requestResize(sessionId: String, cols: Int, rows: Int) async throws {
        let url = endpoint.baseURL.appendingPathComponent("commands/resize")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["sessionId": sessionId, "cols": cols, "rows": rows]
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
    /// **WebSocket-only** endpoint (`apps/agent/src/terminal/stream-manager.ts`),
    /// implemented here with Apple's **Network framework** (`NWConnection` +
    /// `NWProtocolWebSocket`) rather than `URLSessionWebSocketTask`. The
    /// `URLSession` API raises an UNCATCHABLE ObjC `NSException` at task
    /// creation on macOS 26.3 when given an `http://` URL (it requires
    /// `ws://`/`wss://`), and Swift `try/catch` cannot trap an ObjC exception,
    /// so a single mis-call aborted the whole process. `NWConnection` has no
    /// such creation footgun and is Apple's recommended robust WS client —
    /// verified attaching + receiving PTY bytes against the live agent on
    /// macOS 26.3 with no crash.
    ///
    /// Termination contract (mirrors the SSE consumers so
    /// `NexusAggregateClient.multiplex` reconnects identically):
    /// - `.failed(error)` -> throws `NexusClientError.transport(error)`
    ///   (multiplex logs + backs off + retries).
    /// - Clean close / `.cancelled` -> returns normally (multiplex
    ///   re-subscribes after resetting backoff).
    /// - Swift `Task` cancellation (PtyViewer.stop()) -> `conn.cancel()` and
    ///   returns; multiplex observes `Task.isCancelled` and exits.
    ///
    /// Frame routing: **binary** WS frames carry PTY bytes and reach the
    /// handler as `.bytes(Data)`. **Text** frames are agent control messages;
    /// `{"type":"geometry","cols":N,"rows":N}` (shipped agent-side, task 1.4)
    /// is parsed and surfaced as `.geometry(cols:rows:)` so the viewer can
    /// lock its SwiftTerm grid to the source pane (fixes the jumble). Other
    /// control frames (e.g. `replay_done`) are logged, never forwarded.
    /// Binary bytes are delivered in arrival order: the receive loop only
    /// re-arms `receiveMessage` AFTER the per-message `await handler(...)`
    /// completes, so PTY output cannot reorder or interleave.
    public func consumePtyStream(
        sessionId: String,
        handler: @Sendable @escaping (PtyStreamEvent) async -> Void
    ) async throws {
        // 1) Build the ws:// URL. Rewrite the endpoint's http/https scheme to
        //    ws/wss; anything else (or a nil URL) is fatal — never hand a bad
        //    scheme to NWConnection.
        guard var comps = URLComponents(
            url: endpoint.baseURL,
            resolvingAgainstBaseURL: false
        ) else {
            throw NexusClientError.transport(PtyStreamError.badURL)
        }
        switch comps.scheme?.lowercased() {
        case "http", "ws": comps.scheme = "ws"
        case "https", "wss": comps.scheme = "wss"
        default:
            throw NexusClientError.transport(PtyStreamError.badScheme(comps.scheme))
        }
        let basePath = comps.percentEncodedPath
        let escaped = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        comps.percentEncodedPath =
            basePath.hasSuffix("/")
                ? "\(basePath)sessions/\(escaped)/stream"
                : "\(basePath)/sessions/\(escaped)/stream"
        guard let wsURL = comps.url,
              let scheme = wsURL.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else {
            throw NexusClientError.transport(PtyStreamError.badURL)
        }

        // 2) NWConnection + WebSocket options. autoReplyPing keeps the
        //    connection alive without manual pong handling.
        let wsOpts = NWProtocolWebSocket.Options()
        wsOpts.autoReplyPing = true
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(wsOpts, at: 0)
        let conn = NWConnection(to: .url(wsURL), using: params)
        let queue = DispatchQueue(label: "dev.leonardoacosta.nexus.pty.\(sessionId)")

        // 3+6) Bridge the callback-driven connection to async/throws. `gate`
        //    is a Sendable lock-guarded box that guarantees the continuation
        //    resumes EXACTLY ONCE (failed+cancelled races otherwise
        //    double-resume = fatal) and that `conn.cancel()` runs on every
        //    exit path. NWConnection callbacks fire on `queue` (off the actor),
        //    so all shared mutable state lives behind the lock in `gate`,
        //    keeping the bridge data-race-safe without touching actor state.
        let gate = PtyStreamGate(connection: conn)

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (cont: CheckedContinuation<Void, Error>) in
                gate.arm(continuation: cont)

                conn.stateUpdateHandler = { [weak conn] state in
                    switch state {
                    case .failed(let error):
                        ptyLog.error(
                            "PTY WS failed (sessionId=\(sessionId, privacy: .public)): \(String(describing: error), privacy: .public)"
                        )
                        gate.finish(throwing: NexusClientError.transport(error))
                    case .cancelled:
                        // Clean teardown (close or our own cancel) -> normal
                        // return so multiplex re-subscribes.
                        gate.finish(throwing: nil)
                    case .ready:
                        ptyLog.info(
                            "PTY WS ready (sessionId=\(sessionId, privacy: .public))"
                        )
                    case .waiting(let error):
                        ptyLog.debug(
                            "PTY WS waiting (sessionId=\(sessionId, privacy: .public)): \(String(describing: error), privacy: .public)"
                        )
                    default:
                        break
                    }
                    _ = conn
                }

                // Receive loop. Re-arm only AFTER handler completes so PTY
                // bytes stay strictly ordered (no interleaving).
                func receiveLoop() {
                    conn.receiveMessage { data, context, _, error in
                        if let error {
                            gate.finish(throwing: NexusClientError.transport(error))
                            return
                        }
                        // Classify frame: binary = PTY bytes -> handler; text
                        // = agent control message -> log only.
                        let isText: Bool = {
                            guard let meta = context?.protocolMetadata(
                                definition: NWProtocolWebSocket.definition
                            ) as? NWProtocolWebSocket.Metadata else {
                                return false  // default to binary if unknown
                            }
                            return meta.opcode == .text
                        }()

                        if let data, !data.isEmpty {
                            if isText {
                                let msg = String(decoding: data, as: UTF8.self)
                                ptyLog.debug(
                                    "PTY WS control frame (sessionId=\(sessionId, privacy: .public)): \(msg, privacy: .public)"
                                )
                                // Geometry control frame -> surface as a
                                // .geometry event so the viewer can lock its
                                // grid to the source pane. Any other text frame
                                // (replay_done, etc.) is log-only. Re-arm only
                                // AFTER the handler completes so a geometry
                                // event can't race ahead of subsequent bytes.
                                if let geo = PtyControlFrame.geometry(from: data) {
                                    Task {
                                        await handler(.geometry(cols: geo.cols, rows: geo.rows))
                                        receiveLoop()
                                    }
                                } else {
                                    receiveLoop()
                                }
                            } else {
                                // Forward, then re-arm — ordered delivery.
                                Task {
                                    await handler(.bytes(data))
                                    receiveLoop()
                                }
                            }
                        } else {
                            // Empty frame (or close marker with no payload):
                            // keep listening; terminal state arrives via
                            // stateUpdateHandler.
                            receiveLoop()
                        }
                    }
                }
                receiveLoop()

                // 5) Start. If cancellation already raced ahead, finish() is a
                //    no-op and start() cancels harmlessly.
                conn.start(queue: queue)
            }
        } onCancel: {
            // Swift Task cancelled (e.g. PtyViewer.stop()). Cancel the
            // connection; the .cancelled state resumes via the normal path.
            // finish() here also covers the case where the state handler never
            // fires (e.g. cancel before start completes).
            conn.cancel()
            gate.finish(throwing: nil)
        }
    }

    // MARK: - Interactive input channel (pty-raw-interactive-input, nx-bv9oz)

    /// The agent's `WS /sessions/:id/interact` channel. Held while a managed
    /// PTY viewer is attached so keystrokes write raw bytes straight to the
    /// PTY (no tmux `send-keys` Enter append — see `sendText` for the old
    /// auto-submitting path, still used by STT command injection).
    private var interactChannel: PtyInteractChannel?

    /// Open `WS /sessions/:id/interact` and claim the writer mutex. Mirrors
    /// `consumePtyStream`'s NWConnection + NWProtocolWebSocket setup (http→ws
    /// scheme rewrite, autoReplyPing) but WRITE-oriented: the connection is
    /// kept open so `sendInteractiveInput` can push binary frames.
    ///
    /// If another client already holds the writer the agent closes the socket
    /// with application code **4009** ("interactive session already held by
    /// another client"); the channel surfaces that (and any other failure) as
    /// a read-only flag rather than throwing — keystrokes degrade to a logged
    /// no-op, the read-only PTY stream keeps flowing. Opening twice tears down
    /// the previous channel first (idempotent re-open on retry).
    public func openInteract(sessionId: String) {
        interactChannel?.close()
        guard let wsURL = Self.interactURL(base: endpoint.baseURL, sessionId: sessionId) else {
            ptyLog.error(
                "interact: bad ws URL (sessionId=\(sessionId, privacy: .public)) — input disabled"
            )
            interactChannel = nil
            return
        }
        let channel = PtyInteractChannel(url: wsURL, sessionId: sessionId)
        interactChannel = channel
        channel.start()
    }

    /// Write raw keystroke bytes over the interact channel as a BINARY WS
    /// frame. No-op (logged once) when the channel is absent or read-only
    /// (4009 denied / connection failed). Crucially does NOT append Enter —
    /// the agent's `pty.write(data)` path forwards the bytes verbatim, so each
    /// character lands without auto-submitting.
    public func sendInteractiveInput(_ bytes: Data) {
        guard let channel = interactChannel else {
            ptyLog.debug("interact: send dropped — no channel open")
            return
        }
        channel.send(bytes)
    }

    /// True when the interact channel was denied (4009) or failed — keystrokes
    /// are no-ops and the viewer should surface a read-only indicator.
    public func isInteractReadOnly() -> Bool {
        interactChannel?.isReadOnly ?? true
    }

    /// Tear down the interact channel (viewer detach / stop()). Idempotent.
    public func closeInteract() {
        interactChannel?.close()
        interactChannel = nil
    }

    /// Build the `ws(s)://…/sessions/:id/interact` URL from an http(s) base —
    /// the exact scheme-rewrite + path-join logic `consumePtyStream` uses,
    /// factored out so both channels stay in lockstep. Returns nil on a bad
    /// scheme / unconstructable URL (caller treats as "input disabled").
    static func interactURL(base: URL, sessionId: String) -> URL? {
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return nil
        }
        switch comps.scheme?.lowercased() {
        case "http", "ws": comps.scheme = "ws"
        case "https", "wss": comps.scheme = "wss"
        default: return nil
        }
        let basePath = comps.percentEncodedPath
        let escaped = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        comps.percentEncodedPath =
            basePath.hasSuffix("/")
                ? "\(basePath)sessions/\(escaped)/interact"
                : "\(basePath)/sessions/\(escaped)/interact"
        guard let url = comps.url,
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else {
            return nil
        }
        return url
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

// MARK: - PTY WebSocket bridge (nx-gsk4h)

/// One demuxed event off the PTY stream WebSocket.
///
/// The stream interleaves two WS frame types: binary frames carry raw PTY
/// bytes (`.bytes`), and a text geometry control frame
/// (`{"type":"geometry","cols":N,"rows":N}`) reports the source pane's grid
/// so the viewer can lock its SwiftTerm grid to match (fixes the jumble).
/// Surfacing both through one event stream keeps ordering: a `.geometry`
/// arriving between byte bursts is delivered in arrival order.
///
/// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.1)
public enum PtyStreamEvent: Sendable {
    case bytes(Data)
    case geometry(cols: Int, rows: Int)
}

/// Parsed agent control frame off the PTY stream's TEXT channel. Today only
/// `geometry` is consumed; the `type` discriminator lets future control
/// frames slot in without widening the demux.
private struct PtyControlFrame {
    let cols: Int
    let rows: Int

    /// Decode `{"type":"geometry","cols":N,"rows":N}`. Returns nil for any
    /// other text frame (replay_done, malformed JSON, missing fields) so the
    /// receive loop falls through to the log-only path.
    static func geometry(from data: Data) -> PtyControlFrame? {
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            (obj["type"] as? String) == "geometry"
        else { return nil }
        // JSONSerialization decodes JSON numbers as NSNumber; accept Int or
        // a numeric string for robustness against agent encoding drift.
        func intValue(_ any: Any?) -> Int? {
            if let n = any as? NSNumber { return n.intValue }
            if let s = any as? String { return Int(s) }
            return nil
        }
        guard
            let cols = intValue(obj["cols"]), cols > 0,
            let rows = intValue(obj["rows"]), rows > 0
        else { return nil }
        return PtyControlFrame(cols: cols, rows: rows)
    }
}

/// Construction / scheme failures for the PTY WebSocket URL. Wrapped in
/// `NexusClientError.transport` so the caller's reconnect loop treats them
/// like any other transport failure.
private enum PtyStreamError: Error {
    case badURL
    case badScheme(String?)
}

/// Single-resume + teardown guard for `consumePtyStream`'s continuation
/// bridge. `NWConnection`'s `stateUpdateHandler`, the `receiveMessage`
/// completion, and the task-cancellation handler all run on different threads
/// (the connection's DispatchQueue, plus the Swift cancellation hop) and race
/// to terminate the stream. Resuming a `CheckedContinuation` twice is a fatal
/// crash, so every terminal signal funnels through `finish(throwing:)`, which
/// an `NSLock` serializes into exactly one resume and exactly one
/// `conn.cancel()`.
///
/// Marked `@unchecked Sendable`: all mutable state (`continuation`,
/// `isFinished`) is accessed only while holding `lock`, so the class is
/// data-race-safe despite the compiler being unable to prove it. The captured
/// `NWConnection` is itself thread-safe (`cancel()` is callable from any
/// thread). This keeps the actor (`NexusClient`) un-touched by the off-actor
/// callbacks — the bridge owns all cross-thread state.
private final class PtyStreamGate: @unchecked Sendable {
    private let lock = NSLock()
    private let connection: NWConnection
    private var continuation: CheckedContinuation<Void, Error>?
    private var isFinished = false

    init(connection: NWConnection) {
        self.connection = connection
    }

    /// Install the continuation. Called once, before any callback can fire
    /// (inside the `withCheckedThrowingContinuation` body, before `start`).
    func arm(continuation: CheckedContinuation<Void, Error>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    /// Terminate the stream exactly once. `error == nil` resumes normally
    /// (clean close / cancellation -> caller re-subscribes); a non-nil error
    /// resumes throwing (caller backs off + retries). Subsequent calls are
    /// no-ops. Always tears the connection down.
    func finish(throwing error: Error?) {
        lock.lock()
        if isFinished {
            lock.unlock()
            return
        }
        isFinished = true
        let cont = continuation
        continuation = nil
        lock.unlock()

        connection.cancel()
        if let error {
            cont?.resume(throwing: error)
        } else {
            cont?.resume(returning: ())
        }
    }
}

// MARK: - Interactive input channel (pty-raw-interactive-input, nx-bv9oz)

/// Write-oriented WebSocket channel for `WS /sessions/:id/interact`. Mirrors
/// `consumePtyStream`'s `NWConnection` + `NWProtocolWebSocket` setup but instead
/// of a receive loop that forwards PTY output, this channel KEEPS THE
/// CONNECTION OPEN so `send(_:)` can push raw keystroke bytes as binary WS
/// frames straight into the PTY (the agent's `pty.write(data)` path appends no
/// Enter — fixes the auto-submit + redraw-jumble that `POST /commands/send-text`
/// → tmux `send-keys` caused).
///
/// Failure model — never crash, degrade to read-only:
///   - On open, the agent claims the writer mutex. If another client holds it
///     the agent application-closes with code **4009**. That arrives EITHER as
///     a received `.close` message carrying `NWProtocolWebSocket.Metadata`
///     (whose `closeCode` we inspect) OR as the connection going
///     `.failed`/`.cancelled`. Both paths flip `isReadOnly = true`.
///   - Any other transport failure (`.failed`) is also treated as read-only.
///   - `send(_:)` is a no-op once `isReadOnly` is set.
///
/// Marked `@unchecked Sendable`: `isReadOnlyFlag` is the only mutable state and
/// is guarded by `lock`; the captured `NWConnection` is itself thread-safe.
/// `NWConnection` callbacks fire on `queue` (off the actor), so the channel
/// owns all cross-thread state and never touches `NexusClient`'s actor
/// isolation directly.
final class PtyInteractChannel: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let sessionId: String
    private let lock = NSLock()
    private var isReadOnlyFlag = false
    private var started = false

    /// True once the channel was denied (4009) or failed. `send` becomes a
    /// no-op; the viewer surfaces a read-only indicator.
    var isReadOnly: Bool {
        lock.lock(); defer { lock.unlock() }
        return isReadOnlyFlag
    }

    init(url: URL, sessionId: String) {
        self.sessionId = sessionId
        let wsOpts = NWProtocolWebSocket.Options()
        wsOpts.autoReplyPing = true
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(wsOpts, at: 0)
        self.connection = NWConnection(to: .url(url), using: params)
        self.queue = DispatchQueue(
            label: "dev.leonardoacosta.nexus.interact.\(sessionId)"
        )
    }

    /// Open the connection and start watching for the 4009 denied-close (or any
    /// transport failure). Idempotent — a second call is a no-op.
    func start() {
        lock.lock()
        if started { lock.unlock(); return }
        started = true
        lock.unlock()

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                ptyLog.info(
                    "interact WS ready (sessionId=\(self.sessionId, privacy: .public))"
                )
            case .failed(let error):
                // Transport failure (incl. the agent's 4009 application close
                // surfacing as a connection failure) -> read-only.
                ptyLog.error(
                    "interact WS failed (sessionId=\(self.sessionId, privacy: .public)): \(String(describing: error), privacy: .public) — input read-only"
                )
                self.markReadOnly()
            case .cancelled:
                // Clean teardown (our close()) OR the agent's application close.
                // Either way no more input flows.
                self.markReadOnly()
            case .waiting(let error):
                ptyLog.debug(
                    "interact WS waiting (sessionId=\(self.sessionId, privacy: .public)): \(String(describing: error), privacy: .public)"
                )
            default:
                break
            }
        }

        // Receive loop — we don't consume PTY OUTPUT here (the read-only stream
        // channel owns that). We listen ONLY to catch the agent's application
        // close frame (4009 writer-denied) so we can flip read-only with the
        // precise reason. Binary/text data frames on the interact socket are
        // the agent's "not the interactive writer" error replies; we log them.
        receiveLoop()
        connection.start(queue: queue)
    }

    private func receiveLoop() {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let error {
                ptyLog.debug(
                    "interact WS receive error (sessionId=\(self.sessionId, privacy: .public)): \(String(describing: error), privacy: .public)"
                )
                self.markReadOnly()
                return
            }
            if let meta = context?.protocolMetadata(
                definition: NWProtocolWebSocket.definition
            ) as? NWProtocolWebSocket.Metadata {
                if meta.opcode == .close {
                    // Application close. The agent uses 4009 for writer-denied.
                    ptyLog.warning(
                        "interact WS closed by agent (sessionId=\(self.sessionId, privacy: .public), closeCode=\(String(describing: meta.closeCode), privacy: .public)) — input read-only"
                    )
                    self.markReadOnly()
                    return
                }
                if meta.opcode == .text, let data, !data.isEmpty {
                    // Agent control reply (e.g. {"type":"error","message":
                    // "not the interactive writer"}). Treat as a denial signal.
                    let msg = String(decoding: data, as: UTF8.self)
                    ptyLog.warning(
                        "interact WS agent error (sessionId=\(self.sessionId, privacy: .public)): \(msg, privacy: .public) — input read-only"
                    )
                    self.markReadOnly()
                    return
                }
            }
            // Benign frame — keep listening for the close.
            self.receiveLoop()
        }
    }

    /// Send raw keystroke bytes as a BINARY WS frame. No-op once read-only.
    func send(_ bytes: Data) {
        if isReadOnly { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(
            identifier: "interactInput",
            metadata: [meta]
        )
        connection.send(
            content: bytes,
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { [weak self] error in
                guard let self, let error else { return }
                ptyLog.error(
                    "interact WS send failed (sessionId=\(self.sessionId, privacy: .public)): \(String(describing: error), privacy: .public) — input read-only"
                )
                self.markReadOnly()
            }
        )
    }

    /// Tear the connection down. Idempotent.
    func close() {
        markReadOnly()
        connection.cancel()
    }

    private func markReadOnly() {
        lock.lock()
        isReadOnlyFlag = true
        lock.unlock()
    }
}
