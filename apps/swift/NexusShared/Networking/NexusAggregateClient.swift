// NexusAggregateClient — fan-out over every agent in agents.toml.
//
// Spec: nx-4ohfs (Swift-side multi-agent aggregation — replaces the deleted
// peer-connector federation, remove-peer-connector / d2e965e).
//
// NexusClient stays a single-endpoint transport actor (UNCHANGED). This
// actor wraps N of them — one per agents.toml entry — and merges their
// reads with **partial-failure tolerance**: one agent down (e.g. the Mac
// agent stuck in a launchctl wedge) must NOT empty the dashboard. Homelab
// reachable + Mac down -> dashboard still shows homelab's sessions. That is
// the literal bug nx-4ohfs exists to fix.
//
// Mode selection (preserves the interim single-endpoint pin escape hatch):
//   1. SettingsStore.dashboardEndpoint set -> single-client at that URL
//      (lets a user pin one agent; folds in the interim override).
//   2. else agents.toml has entries -> one NexusClient per entry.
//   3. else -> [NexusClient(endpoint: .localhost)] (never zero clients).

import Foundation

public actor NexusAggregateClient {
    /// One transport client per resolved agent.
    private let clients: [NexusClient]
    /// Parallel to `clients` — display name for the agent, used to tag
    /// Session.machine and to surface "M/N agents reachable".
    private let agentNames: [String]

    private static let logPrefix = "[aggregate]"
    private var didLogSelfTest = false

    /// stderr log line, prefixed so `log show … grep aggregate` finds it.
    private static func logLine(_ message: String) {
        let line = "\(logPrefix) \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    public init() {
        let (clients, names) = Self.resolveClients()
        self.clients = clients
        self.agentNames = names
    }

    /// Test / back-compat: wrap an explicit single client (one-agent aggregate).
    public init(client: NexusClient, name: String = "agent") {
        self.clients = [client]
        self.agentNames = [name]
    }

    /// Resolution order matches the mode-selection contract above.
    private static func resolveClients() -> ([NexusClient], [String]) {
        if let raw = SettingsStore.shared.dashboardEndpoint,
           !raw.isEmpty,
           let url = URL(string: raw) {
            return ([NexusClient(endpoint: NexusEndpoint(baseURL: url))], ["pinned"])
        }
        let agents = AgentRegistry.loadAgents()
        if !agents.isEmpty {
            return (
                agents.map { NexusClient(endpoint: $0.endpoint) },
                agents.map(\.name)
            )
        }
        return ([NexusClient(endpoint: .localhost)], ["localhost"])
    }

    // MARK: - Reachability surface (UI: "M/N agents reachable")

    public var agentCount: Int { clients.count }

    /// Names of agents that answered the most recent `fetchSessions()`.
    /// Populated lazily; empty until the first fan-out completes.
    private(set) var lastReachable: [String] = []
    public var reachableAgentNames: [String] { lastReachable }

    // MARK: - Fan-out helpers

    /// Run `body` against every (client, name) pair concurrently. Failures
    /// are logged and dropped — a thrown error from one agent never fails
    /// the whole call. Returns the per-agent results that succeeded plus
    /// the names that answered.
    private func fanOut<T: Sendable>(
        _ label: String,
        _ body: @Sendable @escaping (NexusClient) async throws -> T
    ) async -> (results: [T], reachable: [String]) {
        let pairs = Array(zip(clients, agentNames))
        return await withTaskGroup(of: (String, T?).self) { group in
            for (client, name) in pairs {
                group.addTask {
                    do {
                        return (name, try await body(client))
                    } catch {
                        Self.logLine("\(label): agent '\(name)' failed: \(error)")
                        return (name, nil)
                    }
                }
            }
            var results: [T] = []
            var reachable: [String] = []
            for await (name, value) in group {
                if let value {
                    results.append(value)
                    reachable.append(name)
                }
            }
            return (results, reachable)
        }
    }

    // MARK: - HTTP fetchers (merged across agents)

    /// Merged sessions from every reachable agent. `Session.machine` is
    /// stamped with the source agent name ONLY when the agent left it nil /
    /// empty / "local" (don't clobber a real machine the agent set itself).
    /// Dedup by `Session.id`, last-writer-wins; collisions are logged.
    public func fetchSessions(withFingerprint: Bool = true) async -> [Session] {
        let (perAgent, reachable) = await fanOut("fetchSessions") { client in
            (try await client.fetchSessions(withFingerprint: withFingerprint))
        }
        self.lastReachable = reachable

        var merged: [String: Session] = [:]
        for (idx, rows) in perAgent.enumerated() {
            // `reachable[idx]` lines up with `perAgent[idx]` — fanOut appends
            // both in lockstep.
            let source = idx < reachable.count ? reachable[idx] : "unknown"
            for var s in rows {
                if (s.machine ?? "").isEmpty || s.machine == "local" {
                    s.machine = source
                }
                if let existing = merged[s.id], existing.machine != s.machine {
                    Self.logLine("session id collision across agents: \(s.id) "
                        + "(\(existing.machine ?? "?") vs \(s.machine ?? "?"))")
                }
                merged[s.id] = s
            }
        }

        if !didLogSelfTest {
            didLogSelfTest = true
            Self.logLine("\(clients.count) agents configured, "
                + "\(reachable.count) reachable, \(merged.count) sessions merged")
        }
        return Array(merged.values)
    }

    public func fetchHealthHistory(hours: Double = 0.167) async -> [HealthSnapshot] {
        let (perAgent, _) = await fanOut("fetchHealthHistory") { client in
            try await client.fetchHealthHistory(hours: hours)
        }
        return perAgent.flatMap { $0 }
    }

    public func fetchHealthSeries(machine: String = "", since: Date) async -> [HealthSnapshot] {
        let (perAgent, _) = await fanOut("fetchHealthSeries") { client in
            try await client.fetchHealthSeries(machine: machine, since: since)
        }
        return perAgent.flatMap { $0 }.sorted { $0.timestamp < $1.timestamp }
    }

    /// Projects merged across agents, deduped by `id` (project name).
    public func fetchProjects() async -> [ProjectAggregate] {
        let (perAgent, _) = await fanOut("fetchProjects") { client in
            try await client.fetchProjects()
        }
        var merged: [String: ProjectAggregate] = [:]
        for rows in perAgent { for p in rows { merged[p.id] = p } }
        return Array(merged.values)
    }

    /// Specs merged across agents, deduped by `id` (`project/name`).
    public func fetchSpecs(
        status: String? = nil,
        project: String? = nil
    ) async -> [SpecSummary] {
        let (perAgent, _) = await fanOut("fetchSpecs") { client in
            try await client.fetchSpecs(status: status, project: project)
        }
        var merged: [String: SpecSummary] = [:]
        for rows in perAgent { for s in rows { merged[s.id] = s } }
        return Array(merged.values)
    }

    /// Credentials merged across agents, deduped by profile `id`.
    public func fetchCredentials() async -> [CcProfile] {
        let (perAgent, _) = await fanOut("fetchCredentials") { client in
            try await client.fetchCredentials()
        }
        var merged: [String: CcProfile] = [:]
        for rows in perAgent { for c in rows { merged[c.id] = c } }
        return Array(merged.values)
    }

    /// Script errors merged across agents, newest first.
    public func fetchScriptErrors(limit: Int = 50, days: Int = 7) async -> [ScriptError] {
        let (perAgent, _) = await fanOut("fetchScriptErrors") { client in
            try await client.fetchScriptErrors(limit: limit, days: days)
        }
        let all = perAgent.flatMap { $0 }.sorted { $0.capturedAt > $1.capturedAt }
        return Array(all.prefix(limit))
    }

    /// Integration status merged across agents, deduped by `id`.
    public func fetchIntegrations() async -> [IntegrationStatus] {
        let (perAgent, _) = await fanOut("fetchIntegrations") { client in
            try await client.fetchIntegrations()
        }
        var merged: [String: IntegrationStatus] = [:]
        for rows in perAgent { for i in rows { merged[i.id] = i } }
        return Array(merged.values)
    }

    /// Best-effort settings patch — applied to every agent (the primary
    /// owns notification policy, but mirroring to all is harmless and keeps
    /// peers consistent). Fire-and-forget.
    public func patchNotificationSettings(_ body: [String: Any]) async {
        let sendable = NotificationSettingsBody(body)
        await withTaskGroup(of: Void.self) { group in
            for client in clients {
                group.addTask { await client.patchNotificationSettings(sendable.value) }
            }
        }
    }

    /// Set/clear a project's persisted `hidden` flag. A project lives on
    /// exactly one agent; fan out to all — the owner applies it, the rest
    /// 404 harmlessly (same idiom as the PTY stream fan-out). Best-effort,
    /// fire-and-forget; the UI does an optimistic removal + refresh.
    public func patchProject(id: String, hidden: Bool) async {
        await withTaskGroup(of: Void.self) { group in
            for client in clients {
                group.addTask { await client.patchProject(id: id, hidden: hidden) }
            }
        }
    }

    // MARK: - SSE multiplexing

    /// Subscribe to `/events/stream` on EVERY agent concurrently and
    /// multiplex frames through one handler. Each agent gets its own retry
    /// loop — a dropped stream from one agent must not kill the others.
    /// This call never returns until cancelled.
    public func consumeEvents(
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async {
        await multiplex("events") { client in
            try await client.consumeEvents(handler: handler)
        }
    }

    public func consumeSpecEvents(
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async {
        await multiplex("specEvents") { client in
            try await client.consumeSpecEvents(handler: handler)
        }
    }

    public func consumeNotifications(
        handler: @Sendable @escaping (NotificationEvent) async -> Void
    ) async {
        await multiplex("notifications") { client in
            try await client.consumeNotifications(handler: handler)
        }
    }

    /// PTY streams are session-scoped; a session lives on exactly one agent.
    /// Subscribe on all agents — only the owner has the session and the rest
    /// 404 fast and retry harmlessly. Keeps the call agent-agnostic so the
    /// viewer doesn't need to know which peer owns the session.
    public func consumePtyStream(
        sessionId: String,
        handler: @Sendable @escaping (Data) async -> Void
    ) async {
        await multiplex("pty[\(sessionId)]") { client in
            try await client.consumePtyStream(sessionId: sessionId, handler: handler)
        }
    }

    /// Run a streaming subscription against every agent, each with its own
    /// exponential-backoff retry. Runs until the surrounding task is
    /// cancelled.
    private func multiplex(
        _ label: String,
        _ subscribe: @Sendable @escaping (NexusClient) async throws -> Void
    ) async {
        await withTaskGroup(of: Void.self) { group in
            for (client, name) in zip(clients, agentNames) {
                group.addTask {
                    var backoff: UInt64 = 1_000_000_000
                    let maxBackoff: UInt64 = 30 * 1_000_000_000
                    while !Task.isCancelled {
                        do {
                            try await subscribe(client)
                            backoff = 1_000_000_000
                        } catch {
                            if Task.isCancelled { return }
                            Self.logLine("\(label): agent '\(name)' stream "
                                + "dropped, retrying: \(error)")
                            try? await Task.sleep(nanoseconds: backoff)
                            backoff = min(maxBackoff, backoff * 2)
                        }
                    }
                }
            }
        }
    }
}

/// `[String: Any]` is not Sendable; wrap it for the patch fan-out. The body
/// is a small, value-only settings dict — safe to ferry across the actor.
private struct NotificationSettingsBody: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}
