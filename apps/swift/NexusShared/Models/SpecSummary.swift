// SpecSummary — Codable mirror of the agent's /specs row.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.3)
//
// Source of truth: apps/agent/src/services/spec-watcher/parser.ts
// (`SpecSnapshot`) plus the `project` field stitched in by
// `apps/agent/src/routes/specs.ts handleListSpecs`.
//
// Decodes from the array returned by `GET /specs[?status=…]`.

import Foundation

public struct SpecSummary: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var name: String
    public var project: String
    public var status: String
    public var completedTasks: Int
    public var totalTasks: Int
    public var lastModified: Date?

    public var id: String { "\(project)/\(name)" }

    public var progress: Double {
        totalTasks > 0 ? Double(completedTasks) / Double(totalTasks) : 0
    }

    public enum CodingKeys: String, CodingKey {
        case name
        case project
        case status
        case completedTasks
        case totalTasks
        case lastModified
    }

    public init(
        name: String,
        project: String,
        status: String,
        completedTasks: Int,
        totalTasks: Int,
        lastModified: Date? = nil
    ) {
        self.name = name
        self.project = project
        self.status = status
        self.completedTasks = completedTasks
        self.totalTasks = totalTasks
        self.lastModified = lastModified
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name           = try c.decode(String.self, forKey: .name)
        self.project        = try c.decode(String.self, forKey: .project)
        self.status         = try c.decode(String.self, forKey: .status)
        self.completedTasks = try c.decodeIfPresent(Int.self, forKey: .completedTasks) ?? 0
        self.totalTasks     = try c.decodeIfPresent(Int.self, forKey: .totalTasks) ?? 0
        if let s = try c.decodeIfPresent(String.self, forKey: .lastModified) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.lastModified = f1.date(from: s) ?? f2.date(from: s)
        } else {
            self.lastModified = nil
        }
    }
}
