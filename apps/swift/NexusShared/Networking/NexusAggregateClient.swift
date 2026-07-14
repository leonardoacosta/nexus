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
    /// `var` (was `let`) so `rebootstrap()` can swap the list when the
    /// agents.toml editor saves. Reads stay actor-isolated, so callers
    /// always see a consistent (clients, agentNames) pair.
    /// Spec: settings-tab-redesign (task 1.2, bd:nx-ymz1v)
    private var clients: [NexusClient]
    /// Parallel to `clients` — display name for the agent, used to tag
    /// Session.machine and to surface "M/N agents reachable".
    private var agentNames: [String]

    /// AgentsConfigChanged observer token. Held weakly by NotificationCenter
    /// but we retain the token here so removeObserver works in deinit.
    /// Spec: settings-tab-redesign (task 1.3, bd:nx-na0yx)
    private var configChangedObserver: NSObjectProtocol?
    /// Debounce window for rapid AgentsConfigChanged posts (operator
    /// typing while Save fires repeatedly). 200ms matches the design.md
    /// recommendation in the proposal.
    private var pendingRebootstrap: Task<Void, Never>?

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
        // Observer registration must happen synchronously so the actor
        // catches the first AgentsConfigChanged post; the closure hops
        // back onto the actor via Task to call `rebootstrap()`.
        Task { await self.startObservingConfig() }
    }

    /// Test / back-compat: wrap an explicit single client (one-agent aggregate).
    public init(client: NexusClient, name: String = "agent") {
        self.clients = [client]
        self.agentNames = [name]
    }

    /// Test: wrap an explicit list of clients + parallel display names
    /// (multi-agent aggregate). Lets a test build a mix of reachable and
    /// unreachable agents to exercise the reachability signal.
    public init(clients: [NexusClient], names: [String]) {
        self.clients = clients
        self.agentNames = names
    }

    deinit {
        if let token = configChangedObserver {
            NotificationCenter.default.removeObserver(token)
        }
    }

    // MARK: - Rebootstrap (settings-tab-redesign 1.2 / 1.3)

    /// Re-read agents.toml and rebuild the per-agent NexusClient list.
    /// Cancels any in-flight requests on the previous clients via
    /// URLSession invalidation through reinit (NexusClient is an actor
    /// owning its own URLSession; the old reference dropping is enough
    /// to retire its session — the swap below replaces the entire array).
    public func rebootstrap() async {
        let (newClients, newNames) = Self.resolveClients()
        // Best-effort: ask outgoing clients to drop in-flight transport.
        for c in clients {
            await c.invalidateSessions()
        }
        clients = newClients
        agentNames = newNames
        lastReachable = []
        didLogSelfTest = false
        Self.logLine("rebootstrap: \(newClients.count) agents resolved")
    }

    /// Register NotificationCenter listener for AgentsConfigChanged.
    /// Debounces 200ms so rapid Save→Save churn collapses into one
    /// rebootstrap call.
    private func startObservingConfig() {
        let token = NotificationCenter.default.addObserver(
            forName: .agentsConfigChanged,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            Task { await self.scheduleRebootstrap() }
        }
        configChangedObserver = token
    }

    /// 200ms debounce — coalesce a burst of AgentsConfigChanged posts.
    private func scheduleRebootstrap() {
        pendingRebootstrap?.cancel()
        pendingRebootstrap = Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            await self.rebootstrap()
        }
    }

    /// Resolution order matches the mode-selection contract above.
    private static func resolveClients() -> ([NexusClient], [String]) {
        if let raw = SettingsStore.shared.dashboardEndpoint,
           !raw.isEmpty,
           let url = URL(string: raw) {
            // Surface the endpoint hostname as the agent name rather than the
            // legacy "pinned" sentinel — the sentinel used to leak into the
            // session row's originAgent label. Fall back to "localhost" when
            // the URL carries no host (mirrors the no-agents branch below).
            // Spec: openspec/changes/session-enrichment (task nx-70ep8).
            let name = (url.host?.isEmpty == false) ? url.host! : "localhost"
            return ([NexusClient(endpoint: NexusEndpoint(baseURL: url))], [name])
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

    /// All configured agent display names (parallel to `clients`), regardless
    /// of reachability. Lets a caller compute "which agents failed to respond"
    /// as `configuredAgentNames − reachableAgentNames`.
    public var configuredAgentNames: [String] { agentNames }

    /// Names of agents that answered the most recent fan-out read
    /// (`fetchSessions()` / `fetchCredentials()`). Populated lazily; empty
    /// until the first fan-out completes.
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

    /// `GET /health/processes?limit=N&machine=…` — fan out across every
    /// reachable agent and return the response from the matching machine
    /// (or the freshest snapshot when no machine filter is set).
    ///
    /// Added by `health-tab-process-view`. The process table polls this at
    /// 5s cadence; partial-failure tolerance means a single dead peer must
    /// not blank out the table.
    ///
    /// Selection:
    ///   - When `machine` is non-nil and matches a reachable agent name,
    ///     return that agent's payload (owner semantics — the agent that
    ///     IS the machine).
    ///   - Otherwise fall back to the snapshot with the most recent
    ///     `collectedAt`, preferring non-empty lists over warming-up
    ///     empties.
    public func fetchHealthProcesses(
        machine: String? = nil,
        limit: Int = 10
    ) async -> HealthProcessesResponse {
        // fanOut tags each result with the agent name via a parallel
        // `reachable` array — pair them up so we can match `machine` to
        // the owning agent.
        let (perAgent, reachable) = await fanOut("fetchHealthProcesses") { client in
            try await client.fetchHealthProcesses(machine: machine, limit: limit)
        }

        // Owner-of-machine: when the caller specified a machine, prefer
        // the response from the agent whose name matches.
        if let machine, !machine.isEmpty {
            for (idx, name) in reachable.enumerated() where name == machine && idx < perAgent.count {
                return perAgent[idx]
            }
        }

        // No machine filter (or no match): pick the snapshot that's both
        // freshest AND non-empty. An empty warming-up payload from one
        // agent must not shadow a populated payload from another.
        let populated = perAgent.filter { !$0.topCpu.isEmpty || !$0.topRam.isEmpty }
        let pool = populated.isEmpty ? perAgent : populated
        if let freshest = pool.max(by: {
            (($0.collectedAt ?? .distantPast) < ($1.collectedAt ?? .distantPast))
        }) {
            return freshest
        }
        // Every agent unreachable / failed — surface an empty payload so
        // the UI can hide the section instead of hanging on a nil model.
        return HealthProcessesResponse(topCpu: [], topRam: [], collectedAt: nil)
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

    /// Spec markdown content (`proposal`/`design`/`tasks`). First agent that
    /// answers with a non-nil body wins. Returns nil when every reachable
    /// agent returns 404 or fails. The spec lives on exactly one agent in
    /// practice (each project is hosted by one machine), so fan-out is
    /// effectively a "which agent owns this project" probe.
    ///
    /// Spec: dashboard-ui-pass-v1 (task 2.1)
    public func fetchSpecContent(
        project: String,
        name: String,
        file: String
    ) async -> String? {
        let (perAgent, _) = await fanOut("fetchSpecContent") { client in
            try await client.fetchSpecContent(project: project, name: name, file: file)
        }
        // First non-nil body wins. perAgent only contains successes (errors
        // are dropped by fanOut), so any non-nil here is the answer.
        for body in perAgent {
            if let body { return body }
        }
        return nil
    }

    /// Unlinked (unplanned) beads for a project, merged across agents and
    /// deduped by bead `id`. A project lives on exactly one agent, so this
    /// is effectively a "which agent owns this project" probe; partial
    /// failure never blanks out the owner's rows.
    ///
    /// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.2)
    public func fetchUnlinkedBeads(project: String) async -> [UnlinkedBead] {
        let (perAgent, _) = await fanOut("fetchUnlinkedBeads") { client in
            try await client.fetchUnlinkedBeads(project: project)
        }
        var merged: [String: UnlinkedBead] = [:]
        for rows in perAgent { for b in rows { merged[b.id] = b } }
        return merged.values.sorted { $0.id < $1.id }
    }

    /// Roadmap capabilities for a project, merged across agents and deduped
    /// by capability `epicId`. Single-owner semantics (each project lives on
    /// one agent); partial failure tolerant.
    ///
    /// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.2)
    public func fetchRoadmap(project: String) async -> [RoadmapCapability] {
        let (perAgent, _) = await fanOut("fetchRoadmap") { client in
            try await client.fetchRoadmap(project: project)
        }
        var merged: [String: RoadmapCapability] = [:]
        for rows in perAgent { for c in rows { merged[c.epicId] = c } }
        return merged.values.sorted { $0.name < $1.name }
    }

    /// All-projects unlinked beads across the fleet. Each agent fans out over
    /// its OWN non-hidden projects (`project=all`), and this layer merges those
    /// per-agent results deduped by bead `id`. Since a project lives on exactly
    /// one agent, cross-agent id collisions shouldn't occur; the dedup is the
    /// same last-writer-wins safety net as the single-project path.
    ///
    /// Spec: openspec/changes/refocus-board-shell (task 2.5)
    public func fetchUnlinkedBeadsAll() async -> [UnlinkedBead] {
        let (perAgent, _) = await fanOut("fetchUnlinkedBeadsAll") { client in
            try await client.fetchUnlinkedBeadsAll()
        }
        var merged: [String: UnlinkedBead] = [:]
        for rows in perAgent { for b in rows { merged[b.id] = b } }
        return merged.values.sorted { $0.id < $1.id }
    }

    /// All-projects roadmap across the fleet. Each agent fans out over its OWN
    /// non-hidden projects (`project=all`); this layer merges those per-agent
    /// results deduped by capability `epicId`. Single-owner semantics
    /// (each project lives on one agent); partial failure tolerant.
    ///
    /// Spec: openspec/changes/refocus-board-shell (task 2.5)
    public func fetchRoadmapAll() async -> [RoadmapCapability] {
        let (perAgent, _) = await fanOut("fetchRoadmapAll") { client in
            try await client.fetchRoadmapAll()
        }
        var merged: [String: RoadmapCapability] = [:]
        for rows in perAgent { for c in rows { merged[c.epicId] = c } }
        return merged.values.sorted { $0.name < $1.name }
    }

    /// Active /apply wave plan from the agent that owns the currently-running
    /// run (specs-tab-accordion-with-topology, task 2.2).
    ///
    /// TODAY (single-agent semantics): /apply runs on exactly one machine at
    /// a time, so we accept "first non-nil with a non-empty specStatuses
    /// wins". If every reachable agent returns the empty-state payload
    /// (no active run anywhere), we surface that empty payload instead of
    /// nil so the dashboard can distinguish "nothing in flight" from
    /// "fetch failed".
    ///
    /// FUTURE (multi-agent): once /apply can run concurrently across the
    /// fleet this should merge per-agent runs into a fleet-wide map. For
    /// now there is exactly one canonical `runId` so first-write-wins is
    /// the simplest correct shape.
    public func fetchWavePlanStatus() async -> WavePlanStatus? {
        let (perAgent, _) = await fanOut("fetchWavePlanStatus") { client in
            // fanOut treats `throws` as failure; wrap the non-throwing
            // `Optional` return so a transport-failed agent never silences
            // a healthy one.
            await client.fetchWavePlanStatus()
        }
        // Drop transport failures (per-agent nil) then prefer an active
        // payload over an empty-state placeholder.
        let payloads = perAgent.compactMap { $0 }
        if let active = payloads.first(where: { $0.isActive }) {
            return active
        }
        return payloads.first
    }

    /// Credentials merged across agents, deduped by profile `id`.
    ///
    /// `dedupe = true` forwards `?dedupe=true` to each peer agent so the
    /// per-agent list comes back collapsed to primaries-with-sibling-count;
    /// the cross-agent merge by `id` still applies (rare two agents would
    /// own the same credential).
    public func fetchCredentials(dedupe: Bool = false) async -> [CcProfile] {
        let (perAgent, reachable) = await fanOut("fetchCredentials") { client in
            try await client.fetchCredentials(dedupe: dedupe)
        }
        // Capture the reachability signal (mirrors `fetchSessions()`), so the
        // caller can distinguish "no agent reachable" from "agent reachable,
        // zero credential rows" via `reachableAgentNames`.
        // Spec: implement-native-credential-page-status (task 2.1, bd:nx-9xecw)
        self.lastReachable = reachable
        var merged: [String: CcProfile] = [:]
        for rows in perAgent { for c in rows { merged[c.id] = c } }
        return Array(merged.values)
    }

    /// Usage-history sparkline series for one account. A credential lives on
    /// exactly one agent; fan out to all — the owner answers with its points
    /// and non-owners return `[]` (unknown id) harmlessly. First non-empty
    /// series wins. Returns `[]` when no agent has history for this id.
    ///
    /// Spec: openspec/changes/credential-usage-history (task 3.4) — bd:nx-7v5qm
    public func fetchUsageHistory(
        id: String,
        window: String = "5h",
        sinceHours: Int = 24
    ) async -> [UsageHistoryPoint] {
        let (perAgent, _) = await fanOut("fetchUsageHistory") { client in
            try await client.fetchUsageHistory(
                id: id,
                window: window,
                sinceHours: sinceHours
            )
        }
        return perAgent.first(where: { !$0.isEmpty }) ?? []
    }

    /// Composed account-mode usage for one account via
    /// `GET /statusline?accountId=<id>`. A credential lives on exactly one
    /// agent; fan out to all — the owner answers with its `Account5H7D` and
    /// non-owners 404 (dropped by `fanOut`). First responder wins. Returns
    /// `nil` when no agent has this account (or every agent is older than the
    /// accountId-mode endpoint) so the caller falls back to the `CcProfile`
    /// usage fields.
    ///
    /// Spec: openspec/changes/redesign-status-usage-endpoints (task 3.1) — bd:nx-rqpio
    public func fetchAccountUsage(accountId: String) async -> Account5H7D? {
        let (perAgent, _) = await fanOut("fetchAccountUsage") { client in
            try await client.fetchAccountUsage(accountId: accountId)
        }
        return perAgent.first
    }

    /// Best-effort refresh-identity-all across every reachable agent.
    /// Returns the summed `{ probed, succeeded, failed }` so the UI can
    /// render a single toast. Per-agent failures are dropped.
    public struct AggregateIdentityRefresh: Sendable {
        public var probed: Int
        public var succeeded: Int
        public var failed: Int
    }

    public func refreshAllCredentialIdentities() async -> AggregateIdentityRefresh {
        let (perAgent, _) = await fanOut("refreshAllCredentialIdentities") {
            client in
            try await client.refreshAllCredentialIdentities()
        }
        var totalProbed = 0
        var totalSucceeded = 0
        var totalFailed = 0
        for r in perAgent {
            totalProbed += r.probed
            totalSucceeded += r.succeeded
            totalFailed += r.failed
        }
        return AggregateIdentityRefresh(
            probed: totalProbed,
            succeeded: totalSucceeded,
            failed: totalFailed
        )
    }

    /// Per-row refresh-identity. The credential lives on exactly one agent
    /// (the one that originally added it); fan-out lets the owner answer
    /// while the rest return 404 harmlessly — the first successful response
    /// wins. Returns nil when every agent returned an error.
    public func refreshCredentialIdentity(
        id: String
    ) async -> NexusClient.CredentialIdentityResponse? {
        let (perAgent, _) = await fanOut("refreshCredentialIdentity") {
            client in
            try await client.refreshCredentialIdentity(id: id)
        }
        return perAgent.first
    }

    /// Script errors merged across agents, newest first.
    public func fetchScriptErrors(limit: Int = 50, days: Int = 7) async -> [ScriptError] {
        let (perAgent, _) = await fanOut("fetchScriptErrors") { client in
            try await client.fetchScriptErrors(limit: limit, days: days)
        }
        let all = perAgent.flatMap { $0 }.sorted { $0.capturedAt > $1.capturedAt }
        return Array(all.prefix(limit))
    }

    /// Failures envelope merged across agents. Per-agent topErrors are
    /// concatenated; `byTool` / `byProject` are summed; `trend.current` /
    /// `trend.previous` are summed and direction recomputed from the
    /// totals. `source` and `parseErrors` are picked from the first
    /// responding agent (best-effort provenance).
    ///
    /// Spec: openspec/changes/failures-investigation-and-surface (task 1.8)
    public func fetchFailuresEnvelope(days: Int = 7) async -> FailuresResponse {
        let (perAgent, _) = await fanOut("fetchFailuresEnvelope") { client in
            try await client.fetchFailuresEnvelope(days: days)
        }
        var allTopErrors: [ScriptError] = []
        var byTool: [String: Int] = [:]
        var byProject: [String: Int] = [:]
        var sumCurrent = 0
        var sumPrevious = 0
        var source: String?
        var parseErrors: Int?
        for env in perAgent {
            allTopErrors.append(contentsOf: env.topErrors)
            for (k, v) in env.byTool { byTool[k, default: 0] += v }
            for (k, v) in env.byProject { byProject[k, default: 0] += v }
            sumCurrent += env.trend.current
            sumPrevious += env.trend.previous
            if source == nil { source = env.source }
            if parseErrors == nil { parseErrors = env.parseErrors }
        }
        // Recompute direction from the merged totals using the same rules
        // as the agent (rules/PATTERNS.md keeps this in sync).
        let direction: String = {
            if sumPrevious == 0 && sumCurrent == 0 { return "flat" }
            if sumPrevious == 0 && sumCurrent > 0 { return "up" }
            if Double(sumCurrent) > Double(sumPrevious) * 1.1 { return "up" }
            if Double(sumCurrent) < Double(sumPrevious) * 0.9 { return "down" }
            return "flat"
        }()
        let total = allTopErrors.reduce(0) { $0 + max($1.occurrences, 1) }
        return FailuresResponse(
            periodDays: days,
            total: max(total, sumCurrent),
            topErrors: allTopErrors.sorted { $0.capturedAt > $1.capturedAt },
            byTool: byTool,
            byProject: byProject,
            trend: FailureTrend(current: sumCurrent, previous: sumPrevious, direction: direction),
            source: source,
            parseErrors: parseErrors
        )
    }

    /// Historical notifications merged across agents, deduped by `id`,
    /// newest first. nx-9mt43: NotificationsView mount-time backfill so
    /// the HISTORY sidebar surfaces past rows before live SSE arrives.
    public func fetchNotifications() async -> [NotificationEvent] {
        let (perAgent, _) = await fanOut("fetchNotifications") { client in
            try await client.fetchNotifications()
        }
        var merged: [String: NotificationEvent] = [:]
        for rows in perAgent { for n in rows { merged[n.id.uuidString] = n } }
        return merged.values.sorted { $0.receivedAt > $1.receivedAt }
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

    /// Source index merged across agents. Sources are deduped by `id`
    /// (registry slug), preferring the response from a SERVING agent so one
    /// agent reporting a source DOWN doesn't shadow a healthy peer's row.
    /// Inbox preview rows are deduped by `id` and sorted newest-first.
    ///
    /// Spec: mx-bzzb [nx-ui] Shell / source index view (epic mx-rkir).
    public func fetchSourceIndex() async -> SourceIndex {
        let (perAgent, _) = await fanOut("fetchSourceIndex") { client in
            try await client.fetchSourceIndex()
        }
        var mergedSources: [String: SourceStatus] = [:]
        for payload in perAgent {
            for source in payload.sources {
                // Prefer a SERVING row over a DOWN/unknown one when the same
                // source slug appears from multiple agents.
                if let existing = mergedSources[source.id],
                   existing.health == .serving,
                   source.health != .serving {
                    continue
                }
                mergedSources[source.id] = source
            }
        }
        var mergedInbox: [String: BallInCourtItem] = [:]
        for payload in perAgent {
            for item in payload.inbox { mergedInbox[item.id] = item }
        }
        let inbox = mergedInbox.values.sorted {
            ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast)
        }
        return SourceIndex(sources: Array(mergedSources.values), inbox: inbox)
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

    /// `GET /notifications/:id/audio` on every agent — only the agent
    /// that produced the notification will have the cached MP3; the rest
    /// 404 fast. Returns the first non-empty stream (first wins).
    /// (notifications-overhaul, task 3.2)
    public func streamNotificationAudio(
        id: String
    ) -> AsyncThrowingStream<Data, Error> {
        let snapshot = clients
        return AsyncThrowingStream { continuation in
            Task {
                var lastError: Error?
                for client in snapshot {
                    do {
                        let stream = await client.streamNotificationAudio(id: id)
                        for try await chunk in stream {
                            continuation.yield(chunk)
                        }
                        // First agent that produced bytes wins.
                        continuation.finish()
                        return
                    } catch {
                        lastError = error
                        continue
                    }
                }
                continuation.finish(
                    throwing: lastError ?? NexusClientError.badStatus(404)
                )
            }
        }
    }

    /// Fetch + merge per-project voice overrides across every agent.
    /// On conflict, the last writer wins (overrides should be globally
    /// unique by project; conflicts indicate operator drift).
    public func fetchProjectVoices() async -> [String: String] {
        var merged: [String: String] = [:]
        await withTaskGroup(of: [String: String].self) { group in
            for client in clients {
                group.addTask {
                    (try? await client.fetchProjectVoices()) ?? [:]
                }
            }
            for await partial in group {
                for (k, v) in partial { merged[k] = v }
            }
        }
        return merged
    }

    /// PUT a project voice override on every agent (idempotent upsert).
    /// Fire-and-forget — per-agent failures don't abort the fan-out.
    public func putProjectVoice(project: String, voiceId: String) async {
        await withTaskGroup(of: Void.self) { group in
            for client in clients {
                group.addTask {
                    _ = try? await client.putProjectVoice(
                        project: project,
                        voiceId: voiceId
                    )
                }
            }
        }
    }

    /// DELETE a project voice override on every agent (idempotent).
    public func deleteProjectVoice(project: String) async {
        await withTaskGroup(of: Void.self) { group in
            for client in clients {
                group.addTask {
                    try? await client.deleteProjectVoice(project: project)
                }
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

    /// Forward keystrokes into a managed session's tmux pane. Routes to the
    /// agent identified by `originAgent` when known; falls back to the first
    /// client otherwise (single-agent fleets, or sessions arriving without an
    /// agent tag). Throws `NexusClientError` on transport / non-2xx so the
    /// caller can surface a transient send failure to the user.
    ///
    /// Spec: openspec/changes/session-attach-and-cwd-cap (task 2.1)
    public func sendText(
        sessionId: String,
        text: String,
        originAgent: String? = nil
    ) async throws {
        let client = resolveClient(forAgent: originAgent)
        try await client.sendText(sessionId: sessionId, text: text)
    }

    /// Match `originAgent` (Session.agent ?? Session.machine) against the
    /// `agentNames` array; fall back to the first client when nothing matches
    /// or the hint is nil. `agentNames` is parallel to `clients`, so the
    /// lookup is O(N) over a tiny array.
    private func resolveClient(forAgent originAgent: String?) -> NexusClient {
        if let hint = originAgent,
           let idx = agentNames.firstIndex(of: hint) {
            return clients[idx]
        }
        return clients.first ?? NexusClient(endpoint: .localhost)
    }

    /// PTY streams are session-scoped; a session lives on exactly one agent.
    /// Subscribe on all agents — only the owner has the session and the rest
    /// 404 fast and retry harmlessly. Keeps the call agent-agnostic so the
    /// viewer doesn't need to know which peer owns the session.
    public func consumePtyStream(
        sessionId: String,
        handler: @Sendable @escaping (PtyStreamEvent) async -> Void
    ) async {
        await multiplex("pty[\(sessionId)]") { client in
            try await client.consumePtyStream(sessionId: sessionId, handler: handler)
        }
    }

    /// `POST /commands/resize` — resize a managed session's tmux pane to the
    /// viewer's grid (take-over mode). Routes to `originAgent` when known,
    /// else the first client — same idiom as `sendText`. Throws on transport
    /// / non-2xx so the caller can revert the toggle on a server rejection
    /// (e.g. 409 non-managed).
    ///
    /// Spec: openspec/changes/pty-adaptive-geometry-fullscreen (task 2.2)
    public func requestResize(
        sessionId: String,
        cols: Int,
        rows: Int,
        originAgent: String? = nil
    ) async throws {
        let client = resolveClient(forAgent: originAgent)
        try await client.requestResize(sessionId: sessionId, cols: cols, rows: rows)
    }

    // MARK: - Interactive input channel (pty-raw-interactive-input, nx-bv9oz)

    /// Open `WS /sessions/:id/interact` on the owning agent so keystrokes write
    /// raw bytes straight to the PTY (no tmux `send-keys` Enter append). Routes
    /// to `originAgent` when known, else the first client — same resolution as
    /// `sendText`/`requestResize`. A 4009 writer-denied close is surfaced as a
    /// read-only flag inside the channel (no throw, no crash); query it via
    /// `isInteractReadOnly`.
    public func openInteract(sessionId: String, originAgent: String? = nil) async {
        let client = resolveClient(forAgent: originAgent)
        await client.openInteract(sessionId: sessionId)
    }

    /// Write raw keystroke bytes over the interact channel as a BINARY frame.
    /// No-op when the channel is closed or read-only. Routes to the owning
    /// agent the same way `openInteract` does.
    public func sendInteractiveInput(
        _ bytes: Data,
        originAgent: String? = nil
    ) async {
        let client = resolveClient(forAgent: originAgent)
        await client.sendInteractiveInput(bytes)
    }

    /// True when the interact channel was denied (4009) or failed on the owning
    /// agent — keystrokes are no-ops and the viewer should surface read-only.
    public func isInteractReadOnly(originAgent: String? = nil) async -> Bool {
        let client = resolveClient(forAgent: originAgent)
        return await client.isInteractReadOnly()
    }

    /// Tear down the interact channel on the owning agent (viewer detach).
    public func closeInteract(originAgent: String? = nil) async {
        let client = resolveClient(forAgent: originAgent)
        await client.closeInteract()
    }

    // MARK: - session-start + spec linkage (specs-tab-start-on-spec)

    /// `POST /session/start` — fans out to every reachable agent but only
    /// the agent that OWNS the project path will succeed (others can't
    /// spawn a tmux window for a path they don't see). Returns the
    /// successful response from the first answering agent.
    ///
    /// The owner agent ALSO inserts the `spec_sessions` link row when
    /// `specSlug` is non-nil — that's all on the agent side. Throws when
    /// every agent fails (the project lives on no reachable peer).
    public func startSession(
        project: String,
        path: String,
        specSlug: String? = nil
    ) async throws -> NexusClient.SessionStartResponse {
        let (perAgent, _) = await fanOut("startSession") { client in
            try await client.startSession(
                project: project,
                path: path,
                specSlug: specSlug
            )
        }
        // First successful response wins. Exactly one agent should own the
        // project path; fan-out is the agent-agnostic version of "which
        // peer owns this project?".
        guard let first = perAgent.first else {
            throw NexusClientError.badStatus(404)
        }
        return first
    }

    /// `GET /specs/{project}/{name}/sessions` merged across agents. A spec
    /// link table is owned by exactly one agent (the one whose database
    /// got the insert during /session/start), so the response is
    /// effectively single-agent. Fan-out is partial-failure tolerant — a
    /// dead peer returns empty and never blanks out the owner's payload.
    public func listSpecSessions(
        project: String,
        name: String
    ) async -> [SpecSession] {
        let (perAgent, _) = await fanOut("listSpecSessions") { client in
            try await client.listSpecSessions(project: project, name: name)
        }
        // Dedup by id across agents (rare two agents would hold the same
        // row id, but if it happens last-writer-wins). Sort DESC by
        // createdAt so the merged list mirrors the per-agent contract.
        var merged: [Int: SpecSession] = [:]
        for rows in perAgent { for s in rows { merged[s.id] = s } }
        return merged.values.sorted { $0.createdAt > $1.createdAt }
    }

    /// `PATCH /specs/{project}/{name}/status` — fan out to every agent.
    /// The owner applies the splice; non-owners typically 404. Returns
    /// `true` when at least one agent succeeded. When every agent failed,
    /// the most informative error is thrown so the caller can branch on
    /// 409 (archived → read-only) vs 404 (unknown) vs transport. Spec
    /// status is on-disk state, not a DB row, so single-writer guarantees
    /// hold per the proposal's Risk § "last-writer-wins is acceptable".
    @discardableResult
    public func patchSpecStatus(
        project: String,
        name: String,
        status: String
    ) async throws -> Bool {
        var lastError: Error?
        var anySuccess = false
        await withTaskGroup(of: Result<Bool, Error>.self) { group in
            for client in clients {
                group.addTask {
                    do {
                        _ = try await client.patchSpecStatus(
                            project: project,
                            name: name,
                            status: status
                        )
                        return .success(true)
                    } catch {
                        return .failure(error)
                    }
                }
            }
            for await result in group {
                switch result {
                case .success: anySuccess = true
                case .failure(let err):
                    // Prefer the most informative error — a 409 (archived,
                    // read-only) outranks a 404 (peer doesn't own this
                    // spec), which outranks transport. This mirrors the
                    // single-writer contract: the owner agent's error is
                    // the one the user needs to see.
                    if case NexusClientError.badStatus(409) = err {
                        lastError = err
                    } else if lastError == nil {
                        lastError = err
                    } else if case NexusClientError.badStatus(let code) = err,
                              code != 404,
                              case NexusClientError.badStatus(404)? = lastError {
                        lastError = err
                    }
                }
            }
        }
        if !anySuccess, let err = lastError { throw err }
        return anySuccess
    }

    /// `POST /specs/{project}/{name}/approve` — fan out to every agent; the
    /// owner runs `openspec approve`, non-owners 404 harmlessly. Returns true
    /// when at least one agent succeeded, else throws the most informative
    /// error (same single-writer contract as `patchSpecStatus`).
    /// Refocus-board-shell task 3.5.
    @discardableResult
    public func approveSpec(project: String, name: String) async throws -> Bool {
        try await specAction(label: "approveSpec") { client in
            try await client.approveSpec(project: project, name: name)
        }
    }

    /// `POST /specs/{project}/{name}/reject` — fan out with the same
    /// single-writer semantics as `approveSpec`. Refocus-board-shell task 3.5.
    @discardableResult
    public func rejectSpec(
        project: String,
        name: String,
        reason: String? = nil
    ) async throws -> Bool {
        try await specAction(label: "rejectSpec") { client in
            try await client.rejectSpec(project: project, name: name, reason: reason)
        }
    }

    /// Shared fan-out for owner-scoped spec mutations (approve/reject). At
    /// least one success returns true; when every agent fails, the most
    /// informative error is rethrown (409 > non-404 > 404 > transport).
    private func specAction(
        label: String,
        _ body: @Sendable @escaping (NexusClient) async throws -> Data
    ) async throws -> Bool {
        var lastError: Error?
        var anySuccess = false
        await withTaskGroup(of: Result<Bool, Error>.self) { group in
            for client in clients {
                group.addTask {
                    do { _ = try await body(client); return .success(true) }
                    catch { return .failure(error) }
                }
            }
            for await result in group {
                switch result {
                case .success: anySuccess = true
                case .failure(let err):
                    if case NexusClientError.badStatus(409) = err {
                        lastError = err
                    } else if lastError == nil {
                        lastError = err
                    } else if case NexusClientError.badStatus(let code) = err,
                              code != 404,
                              case NexusClientError.badStatus(404)? = lastError {
                        lastError = err
                    }
                }
            }
        }
        if !anySuccess, let err = lastError { throw err }
        return anySuccess
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
