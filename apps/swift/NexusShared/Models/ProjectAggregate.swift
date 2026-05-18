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

    public var id: String { name }

    public enum CodingKeys: String, CodingKey {
        case name
        case activeSessions = "active_sessions"
        case totalSessions  = "total_sessions"
        case machines
    }

    public init(
        name: String,
        activeSessions: Int,
        totalSessions: Int,
        machines: [String]
    ) {
        self.name = name
        self.activeSessions = activeSessions
        self.totalSessions = totalSessions
        self.machines = machines
    }
}

/// Paginated envelope returned when `cursor` or `limit` is supplied.
public struct ProjectListResponse: Equatable, Codable, Sendable {
    public var items: [ProjectAggregate]
    public var nextCursor: String?
}
