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

/// Orthogonal agent-activity axis derived from the CC lifecycle hook stream
/// (apps/agent/src/services/socket-server/dispatcher.ts). Distinct from
/// `Session.status` (the lifecycle/liveness axis). Nullable on the wire —
/// absent on legacy / telemetry-stub rows, so the row falls back to a neutral
/// sigil. Decoded unknown-tolerant: an unexpected string decodes to `nil`
/// rather than throwing (matches the file's "unknown keys are ignored"
/// contract). Spec: openspec/changes/session-enrichment (task nx-036vw).
public enum AgentState: String, Codable, Sendable {
    /// Mid-turn — running a tool (PreToolUse/PostToolUse/UserPromptSubmit/SubagentStart).
    case blocked
    /// Awaiting user input — permission prompt or idle-await Notification.
    case waiting
    /// Turn ended (Stop hook) — idle, awaiting the next prompt.
    case ready
}

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
    /// Agent-activity state derived from the CC hook stream — `blocked`,
    /// `waiting`, or `ready`. Nullable: absent on legacy rows; an unknown
    /// wire string decodes to nil (see `AgentState` doc + the decoder below).
    /// Drives the SessionRow status sigil. Orthogonal to `status`.
    /// Spec: openspec/changes/session-enrichment (task nx-036vw).
    public var agentState: AgentState?
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
    /// Session lifecycle classification — `"managed"` (tmux-owned, bidirectional
    /// attach available), `"ad_hoc"` (fire-and-forget), `"pooled"` (shared pool),
    /// or `nil` (legacy / unclassified row). Drives the SessionRow tappability
    /// gate and PtyViewer input-forwarding gate in the macOS dashboard.
    ///
    /// Spec: openspec/changes/session-attach-and-cwd-cap (tasks 2.3, 2.4, 2.6)
    public var sessionType: String?

    /// OpenSpec proposal slug the session is working on (`sessions.spec`).
    public var spec: String?
    /// Rate-limit utilization fraction 0.0–1.0 (`sessions.rate_limit_utilization`).
    public var rateLimitUtilization: Double?
    /// Active credential id / fingerprint for this session — subagent-tree +
    /// credential columns the agent writes (add-subagent-tree-columns).
    public var credentialId: String?
    public var credentialFingerprint: String?
    /// Sub-agent tree linkage: the parent session id and this child's role.
    /// Both nil for a top-level session. Drives the Subagent-tree dashboard.
    public var parentSessionId: String?
    public var childRole: String?

    /// Working-tree git status for the session's `cwd`, populated by the
    /// agent alongside the existing git-origin enrichment
    /// (apps/agent/src/services/git-project-resolver.ts /
    /// git-observer.ts `git status --porcelain=v2 --branch`). All three are
    /// nil on legacy rows and on any row the agent hasn't yet resolved — the
    /// SessionRow git-status segment renders only what is present.
    ///
    /// Wire contract (camelCase, per-session): `gitDirty` (working tree has
    /// uncommitted/untracked changes), `gitAhead` / `gitBehind` (commit
    /// distance vs upstream, from `# branch.ab +A -B`). Backend follow-up:
    /// mx-rkir.5 backend half must emit these on `GET /sessions` and add them
    /// to the shared stub-agent SESSIONS_FIXTURE so the drift guard covers them.
    public var gitDirty: Bool?
    public var gitAhead: Int?
    public var gitBehind: Int?

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
        case agentState
        case pid
        case cwd
        case ccSessionId
        case gitProvider
        case gitOwnerRepo
        case totalCostUsd
        case idleSince
        case sessionType
        case spec
        case rateLimitUtilization
        case credentialId
        case credentialFingerprint
        case parentSessionId
        case childRole
        case gitDirty
        case gitAhead
        case gitBehind
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
        // Unknown-tolerant: decode the raw string then map via the failable
        // initializer so an unexpected value (server-side extension) yields
        // nil instead of throwing — mirrors the file's "unknown keys are
        // ignored" contract.
        let agentStateRaw  = try c.decodeIfPresent(String.self, forKey: .agentState)
        self.agentState    = agentStateRaw.flatMap(AgentState.init(rawValue:))
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
        let typeRaw        = try c.decodeIfPresent(String.self, forKey: .sessionType)
        self.sessionType   = (typeRaw?.isEmpty ?? true) ? nil : typeRaw
        self.spec                  = try c.decodeIfPresent(String.self, forKey: .spec)
        self.rateLimitUtilization  = try c.decodeIfPresent(Double.self, forKey: .rateLimitUtilization)
        self.credentialId          = try c.decodeIfPresent(String.self, forKey: .credentialId)
        self.credentialFingerprint = try c.decodeIfPresent(String.self, forKey: .credentialFingerprint)
        self.parentSessionId       = try c.decodeIfPresent(String.self, forKey: .parentSessionId)
        self.childRole             = try c.decodeIfPresent(String.self, forKey: .childRole)
        self.gitDirty              = try c.decodeIfPresent(Bool.self, forKey: .gitDirty)
        self.gitAhead              = try c.decodeIfPresent(Int.self, forKey: .gitAhead)
        self.gitBehind             = try c.decodeIfPresent(Int.self, forKey: .gitBehind)
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
        agentState: AgentState? = nil,
        pid: Int? = nil,
        cwd: String? = nil,
        ccSessionId: String? = nil,
        gitProvider: String? = nil,
        gitOwnerRepo: String? = nil,
        totalCostUsd: Double? = nil,
        idleSince: Date? = nil,
        sessionType: String? = nil,
        spec: String? = nil,
        rateLimitUtilization: Double? = nil,
        credentialId: String? = nil,
        credentialFingerprint: String? = nil,
        parentSessionId: String? = nil,
        childRole: String? = nil,
        gitDirty: Bool? = nil,
        gitAhead: Int? = nil,
        gitBehind: Int? = nil
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
        self.agentState = agentState
        self.pid = pid
        self.cwd = cwd
        self.ccSessionId = ccSessionId
        self.gitProvider = gitProvider
        self.gitOwnerRepo = gitOwnerRepo
        self.totalCostUsd = totalCostUsd
        self.idleSince = idleSince
        self.sessionType = sessionType
        self.spec = spec
        self.rateLimitUtilization = rateLimitUtilization
        self.credentialId = credentialId
        self.credentialFingerprint = credentialFingerprint
        self.parentSessionId = parentSessionId
        self.childRole = childRole
        self.gitDirty = gitDirty
        self.gitAhead = gitAhead
        self.gitBehind = gitBehind
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

    /// Project-label degradation chain used by SessionsRowView and PtyViewer.
    /// Hoisted to NexusShared so the test target (NexusSharedTests) can exercise
    /// it without spinning up the full SwiftUI view hierarchy.
    ///
    /// Fallback ladder: gitOwnerRepo -> projectId -> cwd basename -> "—".
    /// `gitOwnerRepo` wins because `leonardoacosta/oo` is more readable than a
    /// UUID-shaped projectId. The previous "pid <N>" rung was dropped (nx-ds6rq)
    /// once the process-watcher began pulling cwd + tmuxTarget directly from
    /// tmux — watcher-inserted rows now always carry cwd, so the pid fallback
    /// only ever fired on telemetry-stub rows where surfacing a kernel pid as a
    /// user-facing title was confusing rather than helpful.
    public static func projectLabel(for session: Session) -> String {
        if let repo = session.gitOwnerRepo, !repo.isEmpty {
            // Git origin labels arrive percent-encoded for safety in the
            // wire format (e.g. "brownandbrowninc/Wholesale%20Architecture")
            // but humans want decoded text in the dashboard row. Decode is
            // permissive — invalid encodings fall back to the raw string so
            // we never render an empty label.
            return repo.removingPercentEncoding ?? repo
        }
        if let pid = session.projectId, !pid.isEmpty {
            return pid.removingPercentEncoding ?? pid
        }
        if let cwd = session.cwd, !cwd.isEmpty {
            let last = URL(fileURLWithPath: cwd).lastPathComponent
            return last.removingPercentEncoding ?? last
        }
        return "—"
    }

    /// Compact meta line for the PtyViewer header — mirrors the row-level
    /// trailing column ("pid <N> · <machine>" when pid > 0, originAgent alone
    /// otherwise). Hoisted alongside `projectLabel` so the PTY header can
    /// render `[label]  [meta]  [X]` without re-implementing the fallback
    /// in the view layer (bd:nx-dijep).
    public static func metaLine(for session: Session) -> String {
        if let pid = session.pid, pid > 0 {
            return "pid \(pid) · \(session.originAgent)"
        }
        return session.originAgent
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
