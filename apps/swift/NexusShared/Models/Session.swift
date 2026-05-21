// Session — Codable mirror of the agent's session row.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.2)
//
// Source of truth: packages/core/src/types/session.ts. We decode only the
// fields cross-platform Apple targets need; unknown keys are ignored so
// server-side extensions don't break the client.
//
// Date decoding is permissive — accepts ISO8601 fractional, ISO8601 no
// fraction, and numeric epoch (seconds or milliseconds). The agent emits
// JSON dates via .toISOString() but legacy SQLite rows can arrive as Double.

import Foundation

public struct Session: Identifiable, Equatable, Hashable, Decodable, Sendable {
    public var id: String
    public var project: String?
    public var projectId: String?
    public var machine: String?
    /// Origin agent — usually mirrors `machine`. Used to filter sessions to a
    /// specific peer when aggregating across the fleet.
    public var agent: String?
    public var status: String
    public var model: String?
    public var startedAt: Date
    /// `last_activity` in DB, alias `lastHeartbeat` in the agent domain type.
    public var lastHeartbeat: Date
    public var endedAt: Date?
    public var tmuxTarget: String?
    public var tmuxSession: String?
    public var branch: String?
    /// CC fingerprint signals — populated for real Claude Code rows, null on
    /// telemetry-ping stubs.
    public var pid: Int?
    public var cwd: String?
    public var ccSessionId: String?
    /// Git origin enrichment, populated by the agent's git-project-resolver
    /// (apps/agent/src/services/git-project-resolver.ts). The wire shape is
    /// camelCase (see SessionDecodingTests.testDecodesFullStubSessionsWireRow).
    public var gitProvider: String?
    public var gitOwnerRepo: String?
    /// Aggregate cost in USD across the lifetime of the session. Null when
    /// unknown (freshly spawned, or pre-cost-tracking sessions).
    public var totalCostUsd: Double?
    /// Timestamp the session entered the idle state. Drives `Nm idle` rendering
    /// in SessionsView. Null when the session is actively producing tokens.
    public var idleSince: Date?

    public enum CodingKeys: String, CodingKey {
        case id
        case project
        case projectId
        case machine
        case agent
        case status
        case model
        case startedAt
        case lastHeartbeat
        case lastActivity   // alias for lastHeartbeat in the agent's JSON
        case endedAt
        case tmuxTarget
        case tmuxSession
        case branch
        case pid
        case cwd
        case ccSessionId
        case gitProvider
        case gitOwnerRepo
        case totalCostUsd
        case idleSince
    }

    public init(from decoder: Decoder) throws {
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
        self.startedAt     = try Self.decodeFlexibleDate(c, .startedAt) ?? Date()
        let hb = (try? Self.decodeFlexibleDate(c, .lastHeartbeat))
            ?? (try? Self.decodeFlexibleDate(c, .lastActivity))
            ?? nil
        self.lastHeartbeat = hb ?? self.startedAt
        self.endedAt       = (try? Self.decodeFlexibleDate(c, .endedAt)) ?? nil
        self.pid           = try c.decodeIfPresent(Int.self, forKey: .pid)
        let cwdRaw         = try c.decodeIfPresent(String.self, forKey: .cwd)
        self.cwd           = (cwdRaw?.isEmpty ?? true) ? nil : cwdRaw
        self.ccSessionId   = try c.decodeIfPresent(String.self, forKey: .ccSessionId)
        let providerRaw    = try c.decodeIfPresent(String.self, forKey: .gitProvider)
        self.gitProvider   = (providerRaw?.isEmpty ?? true) ? nil : providerRaw
        let ownerRepoRaw   = try c.decodeIfPresent(String.self, forKey: .gitOwnerRepo)
        self.gitOwnerRepo  = (ownerRepoRaw?.isEmpty ?? true) ? nil : ownerRepoRaw
        self.totalCostUsd  = try c.decodeIfPresent(Double.self, forKey: .totalCostUsd)
        self.idleSince     = (try? Self.decodeFlexibleDate(c, .idleSince)) ?? nil
    }

    public init(
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
        ccSessionId: String? = nil,
        gitProvider: String? = nil,
        gitOwnerRepo: String? = nil,
        totalCostUsd: Double? = nil,
        idleSince: Date? = nil
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
        self.gitProvider = gitProvider
        self.gitOwnerRepo = gitOwnerRepo
        self.totalCostUsd = totalCostUsd
        self.idleSince = idleSince
    }

    /// Distinguish a real Claude Code session from telemetry-ping stubs.
    public var hasCCFingerprint: Bool {
        (pid ?? 0) > 0
            || !(tmuxTarget ?? "").isEmpty
            || !(ccSessionId ?? "").isEmpty
            || !(cwd ?? "").isEmpty
            || !(model ?? "").isEmpty
    }

    public var originAgent: String {
        agent ?? machine ?? "unknown"
    }

    /// Project-label degradation chain used by SessionsRowView. Hoisted to
    /// NexusShared so the test target (NexusSharedTests) can exercise it
    /// without spinning up the full SwiftUI view hierarchy.
    ///
    /// Fallback ladder: gitOwnerRepo -> projectId -> cwd basename -> "—".
    /// `gitOwnerRepo` wins because `leonardoacosta/oo` is more readable than
    /// a UUID-shaped projectId.
    public static func projectLabel(for session: Session) -> String {
        if let repo = session.gitOwnerRepo, !repo.isEmpty {
            return repo
        }
        if let pid = session.projectId, !pid.isEmpty {
            return pid
        }
        if let cwd = session.cwd, !cwd.isEmpty {
            return URL(fileURLWithPath: cwd).lastPathComponent
        }
        return "—"
    }

    private static func decodeFlexibleDate(
        _ c: KeyedDecodingContainer<CodingKeys>,
        _ key: CodingKeys
    ) throws -> Date? {
        if let s = try? c.decodeIfPresent(String.self, forKey: key) {
            return iso8601.date(from: s) ?? iso8601NoFraction.date(from: s)
        }
        if let n = try? c.decodeIfPresent(Double.self, forKey: key) {
            return n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
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
