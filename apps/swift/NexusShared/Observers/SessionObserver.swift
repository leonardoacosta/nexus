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
#if os(iOS)
import UserNotifications
#endif

@MainActor
public final class SessionObserver: ObservableObject {
    @Published public private(set) var aggregateState: AggregateState = .unreachable
    @Published public private(set) var sessions: [Session] = []
    @Published public private(set) var metrics: [HealthSnapshot] = []
    @Published public private(set) var notifications: [NotificationEvent] = []
    @Published public private(set) var lastHeartbeat: Date?
    @Published public private(set) var peerReachable: Bool = false
    @Published public private(set) var connectionStatus: String = "connecting"
    /// Most recent `BeadTransition` seen on the SSE stream (per project's
    /// unlinked ready/blocked count change). Decode-only surface for now —
    /// no dashboard UI consumes it yet (add-project-status-snapshots task 3.1).
    @Published public private(set) var lastBeadTransition: BeadTransition?

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
                postLocalNotification(for: ev)
            }
        case "BeadTransition":
            if let t = event.decodeBeadTransition() {
                self.lastBeadTransition = t
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

    /// Post a real system notification for an inbound `NotificationFired` event
    /// (nx-udamp). iOS-only: macOS posts its own banner via TTSObserver, so this
    /// is a no-op there to avoid double-posting. The iOS app already wires the
    /// UNUserNotificationCenter delegate, authorization, foreground presenter,
    /// and tap routing (NexusAppDelegate) — this is the missing bridge that
    /// schedules the request when an SSE event arrives while the app is running
    /// or backgrounded with a live stream.
    ///
    /// Mirrors TTSObserver.postBanner: title = ev.title ?? "Nexus", body =
    /// TTSObserver.renderBody (so multi-item bodies render as a bullet list),
    /// default sound, badge increment, and userInfo carrying project + logPath
    /// for the existing tap-to-open routing. NotificationEvent has no sessionId
    /// in the wire contract, so only project + logPath are forwarded; the tap
    /// handler already degrades gracefully when sessionId is absent.
    private func postLocalNotification(for ev: NotificationEvent) {
        #if os(iOS)
        // notification-fidelity (task 2.4): banner gate. Early-return when the
        // user toggled banners off. Same raw-UserDefaults precedent as
        // TTSObserver.postBanner — .object(forKey:) as? Bool ?? true (NOT
        // .bool(forKey:), which would suppress on fresh install).
        guard UserDefaults.standard.object(forKey: "nx.notifications.bannerEnabled") as? Bool ?? true else {
            return
        }
        let content = UNMutableNotificationContent()
        content.title = ev.displayTitle
        // nx-20caf: surface the custom session name as the banner subtitle
        // when present (UNNotification supports subtitle on iOS too). Mirrors
        // TTSObserver.postBanner; nil/empty -> no subtitle, no change.
        if let sessionName = ev.sessionName, !sessionName.isEmpty {
            content.subtitle = sessionName
        }
        content.body = TTSObserver.renderBody(for: ev)
        content.sound = .default
        content.badge = NSNumber(value: notifications.count)
        if let project = ev.project, !project.isEmpty {
            content.userInfo["project"] = project
        }
        if let logPath = ev.logPath, !logPath.isEmpty {
            content.userInfo[NotificationUserInfoKeys.logPath] = logPath
        }
        if let url = ev.url, !url.isEmpty {
            content.userInfo[NotificationUserInfoKeys.url] = url
        }
        let request = UNNotificationRequest(
            identifier: ev.id.uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
        #endif
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
