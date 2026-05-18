//
//  Models.swift
//  nexus
//
//  Domain types consumed by the menu bar. Mirror just the fields the panel
//  needs from the agent's API surface (apps/agent/src/routes/{sessions,
//  health-history,events-sse}.ts). Decoders are forgiving — unknown keys are
//  ignored so server-side extensions don't break the client.
//
//  NexusShared migration (nx-4roof): `NexusSession` and `NotificationEvent`
//  are now typealiases to the canonical types in `apps/swift/NexusShared/`.
//  `AggregateState` stays local because its accessibility text uses
//  menu-bar-specific "homelab" wording (NexusShared uses generic "peer").
//  Mac-specific extension methods on the session row (`fromProbe`,
//  `resolvedTmuxWindow`) live in the extension on `NexusShared.Session`
//  below.
//

import Foundation
import NexusShared

// MARK: - Aggregate state

/// Five mutually-exclusive icon variants per spec § "Menu bar icon reflects
/// aggregate homelab state". TTS-muted is an overlay (separate boolean) that
/// composes with any of the base states.
enum AggregateState: String, Equatable, Hashable, Codable, Sendable {
    case active       // homelab reachable AND >= 1 session running
    case idle         // homelab reachable AND zero sessions
    case stale        // last heartbeat 30s < age <= 5min
    case unreachable  // last heartbeat > 5min OR explicit PeerLost
}

extension AggregateState {
    /// Derive the variant from raw inputs. Single source of truth — tested in
    /// `AggregateStateTests`. Nonisolated so the actor can call it without
    /// hopping to MainActor.
    nonisolated static func derive(
        lastHeartbeat: Date?,
        sessionCount: Int,
        peerLost: Bool,
        now: Date = Date()
    ) -> AggregateState {
        if peerLost { return .unreachable }
        guard let hb = lastHeartbeat else { return .unreachable }
        let age = now.timeIntervalSince(hb)
        if age > 300 { return .unreachable }     // > 5 min
        if age > 30  { return .stale }           // 30 s ..= 5 min
        return sessionCount > 0 ? .active : .idle
    }

    nonisolated var accessibilityLabel: String {
        switch self {
        case .active:      return "Nexus: homelab active"
        case .idle:        return "Nexus: homelab idle"
        case .stale:       return "Nexus: homelab stale heartbeat"
        case .unreachable: return "Nexus: homelab unreachable"
        }
    }
}

// MARK: - Session

/// Legacy menu-bar type name. Now an alias for the cross-platform
/// `NexusShared.Session`. `originAgent` and `hasCCFingerprint` ship on the
/// canonical type; menu-bar-specific helpers (`fromProbe`,
/// `resolvedTmuxWindow`) live in the extension below.
typealias NexusSession = NexusShared.Session

extension Session {
    /// Construct a synthetic row from a homelab process probe (`pgrep -af`).
    /// Used as the **B** fallback when `/sessions` has zero rows with a CC
    /// fingerprint — bypasses the broken agent path until
    /// `fix-agent-cc-session-tracking` lands.
    static func fromProbe(pid: Int, command: String, host: String, project: String?) -> Session {
        let id = "probe-\(host)-\(pid)"
        return Session(
            id: id,
            project: project ?? "?",
            status: "active",
            model: "claude",
            startedAt: Date(),
            lastHeartbeat: Date(),
            pid: pid,
            cwd: command
        )
    }

    /// Per design.md §A2: client reconstructs `<project>-<timestamp>` from
    /// the canonical naming convention in
    /// `apps/agent/src/routes/sessions.ts:239`. Server-side `tmuxWindow` field
    /// is a future enhancement — if present, it wins.
    nonisolated var resolvedTmuxWindow: String {
        if let target = tmuxTarget, !target.isEmpty { return target }
        let project = project ?? projectId ?? "session"
        let millis = Int64(startedAt.timeIntervalSince1970 * 1000)
        return "\(project)-\(millis)"
    }
}

// MARK: - Health history

/// One sparkline-ready point from `GET /health/history?hours=N`. Matches the
/// JSON shape in `apps/agent/src/routes/health-history.ts:9`.
struct HealthPoint: Equatable, Hashable, Codable, Sendable {
    var timestamp: Date
    var cpuPercent: Double?
    var ramPercent: Double?
    var diskPercent: Double?

    enum CodingKeys: String, CodingKey {
        case timestamp
        case cpuPercent = "cpu_percent"
        case ramPercent = "ram_percent"
        case diskPercent = "disk_percent"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .timestamp) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.timestamp = f1.date(from: s) ?? f2.date(from: s) ?? Date()
        } else if let n = try? c.decode(Double.self, forKey: .timestamp) {
            self.timestamp = n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
                : Date(timeIntervalSince1970: n)
        } else {
            self.timestamp = Date()
        }
        self.cpuPercent  = try c.decodeIfPresent(Double.self, forKey: .cpuPercent)
        self.ramPercent  = try c.decodeIfPresent(Double.self, forKey: .ramPercent)
        self.diskPercent = try c.decodeIfPresent(Double.self, forKey: .diskPercent)
    }

    nonisolated init(timestamp: Date, cpuPercent: Double?, ramPercent: Double?, diskPercent: Double? = nil) {
        self.timestamp = timestamp
        self.cpuPercent = cpuPercent
        self.ramPercent = ramPercent
        self.diskPercent = diskPercent
    }
}

// MARK: - Notification event (NotificationFired SSE payload)

/// Legacy menu-bar type name. The canonical type now lives in NexusShared so
/// iOS / watchOS targets share the wire format. Local alias retained so
/// existing menu-bar call sites don't churn.
typealias NotificationEvent = NexusShared.NotificationEvent

// MARK: - In-app alert (rendered by AlertStrip)

struct NexusAlert: Equatable, Hashable, Sendable {
    enum Severity: Sendable { case amber, critical }
    var severity: Severity
    var body: String
    var actionLabel: String?
    /// Identifier the panel uses to dispatch the alert's resolution action.
    var actionKey: String?
}

// MARK: - Bundled project registry

/// Default project mapping for `⌃⌥H spawn`. The wireframe assumes a single
/// remote ("homelab"), and the spec defaults to `nx` at
/// `/home/nyaptor/dev/<code>`. The fleet table from the global CLAUDE.md is
/// the source of truth; defaulting is fine for v1.
struct ProjectTarget: Equatable, Hashable, Codable, Sendable {
    var code: String
    var path: String
}
