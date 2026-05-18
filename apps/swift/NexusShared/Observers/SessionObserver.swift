// SessionObserver — @MainActor ObservableObject mirroring agent state.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.4)
//
// SwiftUI views on any Apple target (macOS, iOS, watchOS) bind to a
// SessionObserver instance. The observer owns the SSE + polling tasks,
// derives AggregateState, and republishes via @Published for SwiftUI.
//
// This replaces the pre-NexusShared `NexusViewModel` in nexus-mac/.
// The mac app retains its NexusViewModel for now; SessionObserver is
// the new cross-platform surface that iOS / watchOS targets adopt.

import Foundation
import Combine

@MainActor
public final class SessionObserver: ObservableObject {
    @Published public private(set) var aggregateState: AggregateState = .unreachable
    @Published public private(set) var sessions: [Session] = []
    @Published public private(set) var metrics: [HealthSnapshot] = []
    @Published public private(set) var notifications: [NotificationEvent] = []
    @Published public private(set) var lastHeartbeat: Date?
    @Published public private(set) var peerReachable: Bool = false
    @Published public private(set) var connectionStatus: String = "connecting"

    /// Multi-agent fan-out (agents.toml). Replaces the single-endpoint
    /// `NexusClient` field — partial-failure tolerant per nx-4ohfs.
    public let client: NexusAggregateClient

    private var sseTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var peerLost: Bool = false
    private let notificationCap: Int

    public init(aggregate: NexusAggregateClient = NexusAggregateClient(), notificationCap: Int = 50) {
        self.client = aggregate
        self.notificationCap = notificationCap
    }

    /// Back-compat / tests: wrap a single transport client in a trivial
    /// one-agent aggregate so existing call sites keep working.
    public convenience init(client: NexusClient, notificationCap: Int = 50) {
        self.init(aggregate: NexusAggregateClient(client: client), notificationCap: notificationCap)
    }

    // MARK: - Lifecycle

    public func startStreams() {
        if sseTask == nil {
            sseTask = Task { [weak self] in await self?.runSSE() }
        }
        if pollTask == nil {
            pollTask = Task { [weak self] in await self?.runPolling() }
        }
    }

    public func stopStreams() {
        sseTask?.cancel(); sseTask = nil
        pollTask?.cancel(); pollTask = nil
    }

    // MARK: - Polling loop

    private func runPolling() async {
        while !Task.isCancelled {
            await refreshSessions()
            await refreshHealth()
            recordHeartbeat(at: Date())
            try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
        }
    }

    public func refreshSessions() async {
        // Aggregate swallows per-agent failures and returns the merged
        // survivors — one agent down no longer empties the dashboard.
        let rows = await client.fetchSessions(withFingerprint: true)
        self.sessions = rows
        recompute()
    }

    public func refreshHealth() async {
        let pts = await client.fetchHealthHistory(hours: 0.167)
        self.metrics = pts
        recompute()
    }

    // MARK: - SSE loop

    private func runSSE() async {
        // The aggregate owns per-agent retry loops internally; this call
        // returns only on cancellation. We don't see individual agent drops
        // here (polling + `connected` frames keep aggregateState fresh).
        self.connectionStatus = "connecting"
        await client.consumeEvents { [weak self] event in
            await self?.handle(event: event)
        }
    }

    private func handle(event: SSEEvent) async {
        switch event.name {
        case "connected":
            self.connectionStatus = "connected"
        case "RemoteSessionStarted":
            if let s = event.decodeSession() {
                upsertSession(s)
            }
        case "RemoteSessionEnded":
            if let id = event.decodeSessionId() {
                removeSession(id: id)
            }
        case "HomelabHeartbeat":
            let (cpu, ram) = event.decodeHeartbeatMetrics()
            recordHeartbeat(at: Date(), cpu: cpu, ram: ram)
        case "PeerLost":
            self.peerLost = true
            recompute()
        case "NotificationFired":
            if let ev = event.decodeNotification() {
                prependNotification(ev)
            }
        default:
            break
        }
    }

    // MARK: - Mutations

    private func upsertSession(_ s: Session) {
        if let idx = sessions.firstIndex(where: { $0.id == s.id }) {
            sessions[idx] = s
        } else {
            sessions.append(s)
        }
        recompute()
    }

    private func removeSession(id: String) {
        sessions.removeAll { $0.id == id }
        recompute()
    }

    private func recordHeartbeat(at date: Date, cpu: Double? = nil, ram: Double? = nil) {
        lastHeartbeat = date
        peerLost = false
        if cpu != nil || ram != nil {
            metrics.append(HealthSnapshot(timestamp: date, cpuPercent: cpu, ramPercent: ram))
            if metrics.count > 60 { metrics.removeFirst(metrics.count - 60) }
        }
        recompute()
    }

    private func prependNotification(_ ev: NotificationEvent) {
        notifications.insert(ev, at: 0)
        if notifications.count > notificationCap {
            notifications.removeLast(notifications.count - notificationCap)
        }
    }

    private func recompute() {
        let homelab = activeSessions
        let state = AggregateState.derive(
            lastHeartbeat: lastHeartbeat,
            sessionCount: homelab.count,
            peerLost: peerLost
        )
        self.aggregateState = state
        self.peerReachable = state != .unreachable
    }

    public var activeSessions: [Session] {
        let cutoff = Date().addingTimeInterval(-300)
        return sessions.filter {
            guard $0.status.lowercased() == "active",
                  $0.endedAt == nil,
                  $0.lastHeartbeat >= cutoff else { return false }
            return $0.hasCCFingerprint
        }
    }
}
