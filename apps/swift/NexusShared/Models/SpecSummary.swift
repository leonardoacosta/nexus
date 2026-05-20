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

    /// Filesystem-presence tri-state for the spec's three canonical markdown
    /// artifacts. Spec-watcher computes these at scan time from the spec
    /// directory contents. Spec: agent-payload-completeness § Spec Watcher
    /// Emits Marker Tri-State. Non-optional in the model; older agents that
    /// omit the keys decode as `false` via `decodeIfPresent`.
    public var hasProposal: Bool
    public var hasDesign: Bool
    public var hasTasks: Bool

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
        case hasProposal = "has_proposal"
        case hasDesign   = "has_design"
        case hasTasks    = "has_tasks"
    }

    public init(
        name: String,
        project: String,
        status: String,
        completedTasks: Int,
        totalTasks: Int,
        lastModified: Date? = nil,
        hasProposal: Bool = false,
        hasDesign: Bool = false,
        hasTasks: Bool = false
    ) {
        self.name = name
        self.project = project
        self.status = status
        self.completedTasks = completedTasks
        self.totalTasks = totalTasks
        self.lastModified = lastModified
        self.hasProposal = hasProposal
        self.hasDesign = hasDesign
        self.hasTasks = hasTasks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name           = try c.decode(String.self, forKey: .name)
        self.project        = try c.decode(String.self, forKey: .project)
        self.status         = try c.decode(String.self, forKey: .status)
        self.completedTasks = try c.decodeIfPresent(Int.self, forKey: .completedTasks) ?? 0
        self.totalTasks     = try c.decodeIfPresent(Int.self, forKey: .totalTasks) ?? 0
        // Backward-tolerant: older agents omit the marker tri-state. Default
        // each to false; current-gen agents always emit booleans.
        self.hasProposal    = try c.decodeIfPresent(Bool.self, forKey: .hasProposal) ?? false
        self.hasDesign      = try c.decodeIfPresent(Bool.self, forKey: .hasDesign) ?? false
        self.hasTasks       = try c.decodeIfPresent(Bool.self, forKey: .hasTasks) ?? false
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
