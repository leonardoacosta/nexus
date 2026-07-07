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

    /// Flat YAML frontmatter parsed from `proposal.md`
    /// (specs-tab-start-on-spec). Optional for back-compat with older
    /// agents that don't yet stitch the frontmatter into `GET /specs/:p/:n`.
    /// Keys preserved verbatim — `status`, `approved-by`, `approved-at`,
    /// `capability`, etc.
    public var frontmatter: [String: String]?

    /// Live per-proposal bead rollup attached by the agent's
    /// `GET /specs/:project/:name` + `GET /specs/all` routes
    /// (add-bead-proposal-roadmap-surface). Optional for back-compat: older
    /// agents (and projects with no `.beads/` dir) omit it or send `null`,
    /// which decodes to `nil` — the UI simply hides the progress bar then.
    public var beadRollup: BeadRollup?

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
        case frontmatter
        case beadRollup
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
        hasTasks: Bool = false,
        frontmatter: [String: String]? = nil,
        beadRollup: BeadRollup? = nil
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
        self.frontmatter = frontmatter
        self.beadRollup = beadRollup
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
        // specs-tab-start-on-spec: optional frontmatter from proposal.md.
        // Older agents don't emit this key; leave nil to signal "unknown"
        // (the UI surfaces a placeholder in that case rather than {}).
        self.frontmatter    = try c.decodeIfPresent([String: String].self, forKey: .frontmatter)
        // add-bead-proposal-roadmap-surface: live bead rollup. Optional +
        // null-tolerant — older agents omit it, current agents may send
        // `null` when the project has no `.beads/` dir.
        self.beadRollup     = try c.decodeIfPresent(BeadRollup.self, forKey: .beadRollup)
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
