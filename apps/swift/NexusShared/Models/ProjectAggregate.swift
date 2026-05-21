// ProjectAggregate — Codable mirror of `GET /projects` row.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.4)
//
// Source of truth: packages/core/src/types/project.ts `Project`.
// Aggregates sessions by name across all known machines.

import Foundation

public struct ProjectAggregate: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var name: String
    public var activeSessions: Int
    public var totalSessions: Int
    public var machines: [String]

    /// Registry project UUID (matches `projects.id`, the value
    /// `PATCH /projects/:id` validates against). `nil` for session-only
    /// fallback buckets (e.g. `(unregistered)`) that have no registry row,
    /// or when an older agent omits the field. The remove affordance is only
    /// shown when this is non-nil. Identity (`id`) stays keyed on `name` so
    /// list dedup/diffing is unchanged.
    public var projectID: String?

    /// Whether the project is hidden from the dashboard's default view.
    /// Surfaced by the agent's `/projects` aggregate response (read from
    /// the `projects.hidden` registry column). Non-optional in the model;
    /// `decodeIfPresent ?? false` preserves backward compatibility with
    /// older agents that don't emit the field. Spec:
    /// agent-payload-completeness § Project Aggregate Includes Hidden Field.
    public var hidden: Bool

    /// Git metadata for the project's cwd. Surfaced by the agent's
    /// `getGitMetadata(cwd)` extension (30s per-cwd cache, 2s subprocess
    /// timeout). Outer optional + inner optionals model the three states:
    ///   - nil           → older agent (field omitted) OR non-git cwd
    ///                     (the agent serialized null).
    ///   - non-nil with `branch == nil`
    ///                  → detached HEAD; ahead/behind hidden in UI.
    ///   - non-nil with `branch != nil`
    ///                  → tracked branch; full metadata surfaces.
    /// Spec: projects-tab-accordion-deeplink § swift-menubar-client.
    public var gitMetadata: GitMetadata?

    public var id: String { name }

    public enum CodingKeys: String, CodingKey {
        case name
        case activeSessions = "active_sessions"
        case totalSessions  = "total_sessions"
        case machines
        case projectID = "id"
        case hidden
        case gitMetadata = "git_metadata"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        activeSessions = try c.decode(Int.self, forKey: .activeSessions)
        totalSessions = try c.decode(Int.self, forKey: .totalSessions)
        machines = try c.decode([String].self, forKey: .machines)
        // Backward-tolerant: older agents omit `id`; a session-only bucket
        // sends `id: null`. Both decode to nil.
        projectID = try c.decodeIfPresent(String.self, forKey: .projectID)
        // Backward-tolerant: older agents omit `hidden`. Default to false
        // (registered-but-visible). Current-gen agents always emit a bool.
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        // Backward-tolerant: older agents omit `git_metadata`; current
        // agents emit either the object or explicit null for non-git cwds.
        // Both omitted and null decode to `nil` so the UI's optional check
        // stays uniform.
        gitMetadata = try c.decodeIfPresent(GitMetadata.self, forKey: .gitMetadata)
    }

    public init(
        name: String,
        activeSessions: Int,
        totalSessions: Int,
        machines: [String],
        projectID: String? = nil,
        hidden: Bool = false,
        gitMetadata: GitMetadata? = nil
    ) {
        self.name = name
        self.activeSessions = activeSessions
        self.totalSessions = totalSessions
        self.machines = machines
        self.projectID = projectID
        self.hidden = hidden
        self.gitMetadata = gitMetadata
    }
}

/// Paginated envelope returned when `cursor` or `limit` is supplied.
public struct ProjectListResponse: Equatable, Codable, Sendable {
    public var items: [ProjectAggregate]
    public var nextCursor: String?
}
