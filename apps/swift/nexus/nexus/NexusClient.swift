//
//  NexusClient.swift
//  nexus
//
//  Per design.md §A1, `NexusClient` is a Swift `actor` holding canonical
//  state. SSE frames decoded on a background URLSession task mutate the
//  actor; the @MainActor `NexusViewModel` mirrors the state for SwiftUI.
//

import Foundation
import Combine

// MARK: - Configuration

struct NexusEndpoint {
    /// Default local-agent URL. Per add-swift-menubar/design.md and
    /// `apps/agent/src/server.ts`, the agent listens on 7400 with no auth on
    /// loopback (post drop-attach-secret-gate).
    static let baseURL = URL(string: "http://localhost:7400")!
}

// MARK: - Updates published to view models

/// Coarse-grained snapshot the actor emits to subscribers after each mutation.
/// Mirrors the @Observable shim's mutable surface. Keeping a single envelope
/// means subscribers stay race-free (no partial-update tearing).
struct NexusSnapshot: Equatable, Sendable {
    var aggregateState: AggregateState
    var lastHeartbeat: Date?
    var sessions: [NexusSession]
    var metrics: [HealthPoint]
    var notifications: [NotificationEvent]
    var alert: NexusAlert?
    var ttsEnabled: Bool
    var peerReachable: Bool
    var connectionStatus: String   // human-readable for IdentityRow

    static let empty = NexusSnapshot(
        aggregateState: .unreachable,
        lastHeartbeat: nil,
        sessions: [],
        metrics: [],
        notifications: [],
        alert: nil,
        ttsEnabled: true,
        peerReachable: false,
        connectionStatus: "disconnected"
    )
}

// MARK: - Actor

actor NexusClient {
    // ── Canonical state (actor-isolated) ───────────────────────────────
    private var sessions: [NexusSession] = []
    private var metrics: [HealthPoint] = []
    private var notifications: [NotificationEvent] = []
    private var alert: NexusAlert?
    private var ttsEnabled: Bool = true
    private var lastHeartbeat: Date?
    private var peerLost: Bool = false
    private var connectionStatus: String = "connecting"

    // ── Subscribers ────────────────────────────────────────────────────
    private var subscribers: [UUID: (NexusSnapshot) -> Void] = [:]
    private let snapshotKey: UUID = UUID()

    // ── Persistence handle (injected on init) ──────────────────────────
    let store: NotificationStore

    init(store: NotificationStore = .shared) {
        self.store = store
        self.notifications = store.load()
    }

    // ── Public accessors ───────────────────────────────────────────────

    func subscribe(_ handler: @Sendable @escaping (NexusSnapshot) -> Void) -> UUID {
        let id = UUID()
        subscribers[id] = handler
        // Push initial snapshot synchronously so subscribers get state before
        // any further actor mutation.
        handler(currentSnapshot())
        return id
    }

    func unsubscribe(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }

    func snapshot() -> NexusSnapshot { currentSnapshot() }

    // ── Mutations (called by SSE handler + HTTP polling) ──────────────

    func setSessions(_ rows: [NexusSession]) {
        self.sessions = rows
        publish()
    }

    func upsertSession(_ s: NexusSession) {
        if let idx = sessions.firstIndex(where: { $0.id == s.id }) {
            sessions[idx] = s
        } else {
            sessions.append(s)
        }
        publish()
    }

    func removeSession(id: String) {
        sessions.removeAll { $0.id == id }
        publish()
    }

    func setMetrics(_ points: [HealthPoint]) {
        self.metrics = points
        publish()
    }

    func appendMetric(_ point: HealthPoint, cap: Int = 60) {
        metrics.append(point)
        if metrics.count > cap { metrics.removeFirst(metrics.count - cap) }
        publish()
    }

    func recordHeartbeat(at date: Date = Date(),
                         cpu: Double? = nil,
                         ram: Double? = nil) {
        lastHeartbeat = date
        peerLost = false
        if cpu != nil || ram != nil {
            metrics.append(HealthPoint(timestamp: date, cpuPercent: cpu, ramPercent: ram))
            if metrics.count > 60 { metrics.removeFirst(metrics.count - 60) }
        }
        publish()
    }

    func markPeerLost() {
        peerLost = true
        publish()
    }

    func prependNotification(_ ev: NotificationEvent, cap: Int = 50) {
        notifications.insert(ev, at: 0)
        if notifications.count > cap {
            notifications.removeLast(notifications.count - cap)
        }
        store.save(notifications)
        publish()
    }

    func clearNotifications() {
        notifications.removeAll()
        store.save(notifications)
        publish()
    }

    func setAlert(_ a: NexusAlert?) {
        alert = a
        publish()
    }

    func setTtsEnabled(_ enabled: Bool) {
        ttsEnabled = enabled
        publish()
    }

    func setConnectionStatus(_ s: String) {
        connectionStatus = s
        publish()
    }

    // ── Snapshot synthesis ─────────────────────────────────────────────

    private func currentSnapshot() -> NexusSnapshot {
        let state = AggregateState.derive(
            lastHeartbeat: lastHeartbeat,
            sessionCount: homelabSessions().count,
            peerLost: peerLost
        )
        return NexusSnapshot(
            aggregateState: state,
            lastHeartbeat: lastHeartbeat,
            sessions: sessions,
            metrics: metrics,
            notifications: notifications,
            alert: alert,
            ttsEnabled: ttsEnabled,
            peerReachable: state != .unreachable,
            connectionStatus: connectionStatus
        )
    }

    private func homelabSessions() -> [NexusSession] {
        // Agent's `/sessions` is currently full of telemetry-ping stubs —
        // every hook event creates an ad_hoc row, ~4000 of them outnumber
        // real Claude Code processes. Discriminate by "has at least one
        // CC fingerprint": pid > 0, tmuxTarget set, cwd set, model set,
        // or the agent stamped a ccSessionId. Stubs fail all checks.
        // Long-term fix tracked in spec `fix-agent-cc-session-tracking`.
        let cutoff = Date().addingTimeInterval(-300)
        return sessions.filter {
            guard $0.status.lowercased() == "active",
                  $0.endedAt == nil,
                  $0.lastHeartbeat >= cutoff else { return false }
            return $0.hasCCFingerprint
        }
    }

    private func publish() {
        let snap = currentSnapshot()
        for handler in subscribers.values { handler(snap) }
    }
}

// MARK: - View model (MainActor SwiftUI bridge)

/// Per design.md §A1, this is the `@MainActor` shim that mirrors the actor's
/// state for SwiftUI views. Uses `ObservableObject` rather than the newer
/// `@Observable` macro to remain compatible with Swift 5.0 — the project's
/// `SWIFT_VERSION` setting.
@MainActor
final class NexusViewModel: ObservableObject {
    static let shared = NexusViewModel()

    @Published private(set) var aggregateState: AggregateState = .unreachable
    @Published private(set) var sessions: [NexusSession] = []
    @Published private(set) var metrics: [HealthPoint] = []
    @Published private(set) var notifications: [NotificationEvent] = []
    @Published private(set) var alert: NexusAlert?
    @Published private(set) var ttsEnabled: Bool = true
    @Published private(set) var lastHeartbeat: Date?
    @Published private(set) var peerReachable: Bool = false
    @Published private(set) var connectionStatus: String = "connecting"

    /// Highlighted session — drives the ATTACH button and the Enter shortcut.
    @Published var selectedSessionId: String?

    let client: NexusClient
    private var subscription: UUID?

    private var sseTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var ttsProvider: String = "elevenlabs"

    init(client: NexusClient = NexusClient()) {
        self.client = client
        Task { await self.attachSubscription() }
    }

    // ── Subscription bridge ───────────────────────────────────────────

    private func attachSubscription() async {
        let id = await client.subscribe { snapshot in
            // Hop to MainActor for the @Published mutations.
            Task { @MainActor in
                self.apply(snapshot: snapshot)
            }
        }
        self.subscription = id
    }

    private func apply(snapshot: NexusSnapshot) {
        self.aggregateState = snapshot.aggregateState
        self.sessions = snapshot.sessions
        self.metrics = snapshot.metrics
        self.notifications = snapshot.notifications
        self.alert = snapshot.alert
        self.ttsEnabled = snapshot.ttsEnabled
        self.peerReachable = snapshot.peerReachable
        self.lastHeartbeat = snapshot.lastHeartbeat
        self.connectionStatus = snapshot.connectionStatus
        // Keep selection valid.
        if let sel = selectedSessionId,
           !snapshot.sessions.contains(where: { $0.id == sel }) {
            selectedSessionId = snapshot.sessions.first?.id
        } else if selectedSessionId == nil {
            selectedSessionId = snapshot.sessions.first?.id
        }
    }

    // ── Convenience for views ─────────────────────────────────────────

    var homelabSessions: [NexusSession] {
        // Mirror of `NexusClient.homelabSessions()` — see actor-side note.
        let cutoff = Date().addingTimeInterval(-300)
        return sessions.filter {
            guard $0.status.lowercased() == "active",
                  $0.endedAt == nil,
                  $0.lastHeartbeat >= cutoff else { return false }
            return $0.hasCCFingerprint
        }
    }

    var selectedSession: NexusSession? {
        guard let id = selectedSessionId else { return nil }
        return sessions.first(where: { $0.id == id })
    }

    // ── Lifecycle helpers fired by views on appear ────────────────────

    func startStreams() {
        if sseTask == nil {
            sseTask = Task { [weak self] in
                await self?.runSSE()
            }
        }
        if pollTask == nil {
            pollTask = Task { [weak self] in
                await self?.runPolling()
            }
        }
    }

    func stopStreams() {
        sseTask?.cancel(); sseTask = nil
        pollTask?.cancel(); pollTask = nil
    }

    private func runPolling() async {
        // Initial fetch + 30-second refresh of REST snapshots. SSE handles
        // live deltas in between. A successful poll cycle counts as liveness
        // for `aggregateState` derivation — the agent doesn't currently emit
        // a periodic `HomelabHeartbeat` SSE event, so without this the panel
        // would render UNREACHABLE forever even when the agent is healthy.
        //
        // Fallback path **B**: if the agent's `/sessions` returns zero rows
        // with a CC fingerprint, SSH-probe homelab for real `claude` PIDs
        // and merge those synthetic rows in. Auto-disables once the agent
        // path returns real fingerprinted rows.
        while !Task.isCancelled {
            await refreshSessions()
            await refreshHealth()
            await client.recordHeartbeat()
            await maybeAugmentWithProbe()
            try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
        }
    }

    private func maybeAugmentWithProbe() async {
        // Opt-in diagnostics fallback. After `fix-agent-cc-session-tracking`
        // ships, the agent populates real CC-fingerprint rows itself, so the
        // SSH probe is no longer needed by default. Users can re-enable it
        // via Preferences → Diagnostics if their agent isn't tracking.
        guard UserDefaults.standard.bool(forKey: "nx.menubar.fallback.processProbe") else { return }
        let current = await client.snapshot().sessions
        let hasReal = current.contains { $0.hasCCFingerprint }
        guard !hasReal else { return }
        let synthetic = await ProcessProbe.shared.probeHomelab()
        if synthetic.isEmpty { return }
        // Replace the telemetry-stub haystack with the synthetic real rows.
        // Stubs aren't useful anyway; presenting both creates duplicate
        // chrome and confuses the count badge.
        await client.setSessions(synthetic)
    }

    func refreshSessions() async {
        do {
            let rows: [NexusSession] = try await Network.getJSON(
                url: NexusEndpoint.baseURL.appendingPathComponent("sessions")
            )
            await client.setSessions(rows)
        } catch {
            // Swallow — peer-lost detection runs through SSE.
        }
    }

    func refreshHealth() async {
        var comps = URLComponents(url: NexusEndpoint.baseURL.appendingPathComponent("health/history"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "hours", value: "0.167")] // 10 minutes
        guard let url = comps.url else { return }
        do {
            let pts: [HealthPoint] = try await Network.getJSON(url: url)
            await client.setMetrics(pts)
        } catch {
            // Non-fatal.
        }
    }

    private func runSSE() async {
        let url = NexusEndpoint.baseURL.appendingPathComponent("events/stream")
        var backoff: UInt64 = 1_000_000_000 // 1s
        let maxBackoff: UInt64 = 30 * 1_000_000_000
        while !Task.isCancelled {
            do {
                await client.setConnectionStatus("connecting")
                try await SSE.consume(url: url) { event in
                    await self.handle(sseEvent: event)
                }
                // consume returned normally — treat as graceful end, reconnect.
                backoff = 1_000_000_000
            } catch {
                if Task.isCancelled { return }
                await client.setConnectionStatus("reconnecting")
                try? await Task.sleep(nanoseconds: backoff)
                backoff = min(maxBackoff, backoff * 2)
            }
        }
    }

    private func handle(sseEvent: SSEEvent) async {
        switch sseEvent.name {
        case "connected":
            await client.setConnectionStatus("connected")
        case "RemoteSessionStarted":
            if let s = sseEvent.decodeSession() {
                await client.upsertSession(s)
            }
        case "RemoteSessionEnded":
            if let id = sseEvent.decodeSessionId() {
                await client.removeSession(id: id)
            }
        case "HomelabHeartbeat":
            let (cpu, ram) = sseEvent.decodeHeartbeatMetrics()
            await client.recordHeartbeat(at: Date(), cpu: cpu, ram: ram)
        case "PeerLost":
            await client.markPeerLost()
        case "NotificationFired":
            if let ev = sseEvent.decodeNotification() {
                await client.prependNotification(ev)
            }
        default:
            break
        }
    }

    // ── Mutations issued by views ─────────────────────────────────────

    func toggleTtsMute() async {
        let next = !ttsEnabled
        await client.setTtsEnabled(next)
        await Network.patchJSON(
            url: NexusEndpoint.baseURL.appendingPathComponent("notifications/settings"),
            body: ["tts_enabled": next]
        )
    }

    func switchTtsProvider(_ provider: String) async {
        ttsProvider = provider
        await Network.patchJSON(
            url: NexusEndpoint.baseURL.appendingPathComponent("notifications/settings"),
            body: ["tts_provider": provider]
        )
    }

    func testVoice() async {
        await Network.postJSON(
            url: NexusEndpoint.baseURL.appendingPathComponent("notifications/send"),
            body: ["body": "TTS test from menu bar", "channel": "tts"]
        )
    }

    func replayNotification(_ ev: NotificationEvent) async {
        var body: [String: Any] = ["body": ev.body]
        if let c = ev.channel { body["channel"] = c }
        if let t = ev.title { body["title"] = t }
        await Network.postJSON(
            url: NexusEndpoint.baseURL.appendingPathComponent("notifications/send"),
            body: body
        )
    }

    func clearNotifications() async {
        await client.clearNotifications()
    }

    func selectSession(id: String?) {
        selectedSessionId = id
    }

    /// Resolves the project + path to use for `/session/start`. Per the spec
    /// scenario, default to the `nx` project at `/home/nyaptor/dev/nx`.
    var spawnTarget: ProjectTarget {
        ProjectTarget(code: "nx", path: "/home/nyaptor/dev/nx")
    }
}
