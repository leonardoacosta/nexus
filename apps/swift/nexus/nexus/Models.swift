//
//  Models.swift
//  nexus
//
//  Domain types consumed by the menu bar. Mirror just the fields the panel
//  needs from the agent's API surface (apps/agent/src/routes/{sessions,
//  health-history,events-sse}.ts). Decoders are forgiving — unknown keys are
//  ignored so server-side extensions don't break the client.
//

import Foundation

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

/// Subset of the agent's `Session` row consumed by the panel. The agent's
/// canonical type (`packages/core/src/types/session.ts`) carries ~25 fields;
/// we decode only the ones the UI needs.
struct NexusSession: Identifiable, Equatable, Hashable, Decodable, Sendable {
    var id: String
    var project: String?
    var projectId: String?
    var machine: String?
    /// Computed agent name per the agent's runtime field — usually mirrors
    /// `machine`. Used to filter the SessionList to homelab-origin sessions.
    var agent: String?
    var status: String
    var model: String?
    var startedAt: Date
    /// `last_activity` in DB, alias `lastHeartbeat` in the agent's domain
    /// type (`packages/core/src/types/session.ts`).
    var lastHeartbeat: Date
    var endedAt: Date?
    var tmuxTarget: String?
    var tmuxSession: String?
    var branch: String?
    /// CC fingerprint signals — populated for real Claude Code rows, null on
    /// telemetry-ping stubs. See `hasCCFingerprint`.
    var pid: Int?
    var cwd: String?
    var ccSessionId: String?

    enum CodingKeys: String, CodingKey {
        case id
        case project
        case projectId
        case machine
        case agent
        case status
        case model
        case startedAt
        case lastHeartbeat
        case lastActivity        // agent's actual JSON key — alias of lastHeartbeat
        case endedAt
        case tmuxTarget
        case tmuxSession
        case branch
        case pid
        case cwd
        case ccSessionId
    }

    /// Permissive ISO8601 decoder — accepts both fractional and non-fractional
    /// forms, plus epoch-millis numbers. Necessary because the agent emits
    /// JSON dates with `.toISOString()` (fractional) while certain rows from
    /// SQLite arrive as numbers.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id            = try c.decode(String.self, forKey: .id)
        self.project       = try c.decodeIfPresent(String.self, forKey: .project)
        self.projectId     = try c.decodeIfPresent(String.self, forKey: .projectId)
        self.machine       = try c.decodeIfPresent(String.self, forKey: .machine)
        self.agent         = try c.decodeIfPresent(String.self, forKey: .agent)
        self.status        = try c.decodeIfPresent(String.self, forKey: .status) ?? "idle"
        self.model         = try c.decodeIfPresent(String.self, forKey: .model)
        self.tmuxTarget    = try c.decodeIfPresent(String.self, forKey: .tmuxTarget)
        self.tmuxSession   = try c.decodeIfPresent(String.self, forKey: .tmuxSession)
        self.branch        = try c.decodeIfPresent(String.self, forKey: .branch)
        self.startedAt     = try Self.decodeFlexibleDate(c, .startedAt)     ?? Date()
        // Agent emits this as `lastActivity` (per apps/agent/src/db/sessions.ts).
        // Older specs / SSE frames may still use `lastHeartbeat`. Either wins;
        // fall back to startedAt rather than Date() so stale rows don't look
        // artificially fresh and pollute the active-window filter.
        let hb = (try? Self.decodeFlexibleDate(c, .lastHeartbeat))
            ?? (try? Self.decodeFlexibleDate(c, .lastActivity))
            ?? nil
        self.lastHeartbeat = hb ?? self.startedAt
        self.endedAt       = (try? Self.decodeFlexibleDate(c, .endedAt)) ?? nil
        self.pid           = try c.decodeIfPresent(Int.self, forKey: .pid)
        // cwd often arrives as "" — treat empty as nil.
        let cwdRaw         = try c.decodeIfPresent(String.self, forKey: .cwd)
        self.cwd           = (cwdRaw?.isEmpty ?? true) ? nil : cwdRaw
        self.ccSessionId   = try c.decodeIfPresent(String.self, forKey: .ccSessionId)
    }

    init(
        id: String,
        project: String? = nil,
        projectId: String? = nil,
        machine: String? = nil,
        agent: String? = nil,
        status: String = "active",
        model: String? = nil,
        startedAt: Date = Date(),
        lastHeartbeat: Date = Date(),
        endedAt: Date? = nil,
        tmuxTarget: String? = nil,
        tmuxSession: String? = nil,
        branch: String? = nil,
        pid: Int? = nil,
        cwd: String? = nil,
        ccSessionId: String? = nil
    ) {
        self.id = id
        self.project = project
        self.projectId = projectId
        self.machine = machine
        self.agent = agent
        self.status = status
        self.model = model
        self.startedAt = startedAt
        self.lastHeartbeat = lastHeartbeat
        self.endedAt = endedAt
        self.tmuxTarget = tmuxTarget
        self.tmuxSession = tmuxSession
        self.branch = branch
        self.pid = pid
        self.cwd = cwd
        self.ccSessionId = ccSessionId
    }
}

extension NexusSession {
    /// Distinguish a real Claude Code session row from telemetry/heartbeat
    /// stubs. The agent currently creates `ad_hoc` rows for every hook event;
    /// real CC rows always carry at least one of these signals.
    var hasCCFingerprint: Bool {
        (pid ?? 0) > 0
            || !(tmuxTarget ?? "").isEmpty
            || !(ccSessionId ?? "").isEmpty
            || !(cwd ?? "").isEmpty
            || !(model ?? "").isEmpty
    }

    /// Construct a synthetic row from a homelab process probe (`pgrep -af`).
    /// Used as the **B** fallback when `/sessions` has zero rows with a CC
    /// fingerprint — bypasses the broken agent path until
    /// `fix-agent-cc-session-tracking` lands.
    static func fromProbe(pid: Int, command: String, host: String, project: String?) -> NexusSession {
        let id = "probe-\(host)-\(pid)"
        return NexusSession(
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

    private static func decodeFlexibleDate(
        _ c: KeyedDecodingContainer<CodingKeys>,
        _ key: CodingKeys
    ) throws -> Date? {
        if let s = try? c.decodeIfPresent(String.self, forKey: key) {
            return Self.iso8601.date(from: s)
                ?? Self.iso8601NoFraction.date(from: s)
        }
        if let n = try? c.decodeIfPresent(Double.self, forKey: key) {
            // Heuristic: > 10^12 means milliseconds, else seconds.
            return n > 1_000_000_000_000 ? Date(timeIntervalSince1970: n / 1000)
                                          : Date(timeIntervalSince1970: n)
        }
        return nil
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601NoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

extension NexusSession {
    /// "agent" semantics in the spec mean "machine of origin". The agent's
    /// `agent` runtime field usually mirrors `machine`. Either is fine for the
    /// homelab filter.
    nonisolated var originAgent: String {
        agent ?? machine ?? "unknown"
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

struct NotificationEvent: Identifiable, Equatable, Hashable, Codable, Sendable {
    var id: UUID
    var body: String
    var channel: String?
    var title: String?
    var emoji: String?
    var receivedAt: Date

    init(
        id: UUID = UUID(),
        body: String,
        channel: String? = nil,
        title: String? = nil,
        emoji: String? = nil,
        receivedAt: Date = Date()
    ) {
        self.id = id
        self.body = body
        self.channel = channel
        self.title = title
        self.emoji = emoji
        self.receivedAt = receivedAt
    }
}

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
