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

    public var id: String { name }

    public enum CodingKeys: String, CodingKey {
        case name
        case activeSessions = "active_sessions"
        case totalSessions  = "total_sessions"
        case machines
        case projectID = "id"
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
    }

    public init(
        name: String,
        activeSessions: Int,
        totalSessions: Int,
        machines: [String],
        projectID: String? = nil
    ) {
        self.name = name
        self.activeSessions = activeSessions
        self.totalSessions = totalSessions
        self.machines = machines
        self.projectID = projectID
    }
}

/// Paginated envelope returned when `cursor` or `limit` is supplied.
public struct ProjectListResponse: Equatable, Codable, Sendable {
    public var items: [ProjectAggregate]
    public var nextCursor: String?
}
