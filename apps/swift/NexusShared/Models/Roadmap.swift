// Roadmap — Codable mirror of the agent's `GET /roadmap?project=` payload.
//
// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.1)
//
// Source of truth: packages/core/src/types/roadmap.ts
// (`RoadmapCapability` / `RoadmapProposal`) plus the runtime aggregator in
// apps/agent/src/services/roadmap-aggregate.ts.
//
// Wire JSON is camelCase → synthesized CodingKeys, no custom mapping.
// Cross-platform: Foundation only (design.md § Non-goals — NexusShared models
// are shared so iOS can adopt without a wire change).

import Foundation

/// Progress rollup for a capability — task counts summed across all of its
/// proposals so the dashboard can render a capability-level bar independent
/// of the per-proposal bars.
public struct RoadmapProgress: Equatable, Hashable, Codable, Sendable {
    public var totalTasks: Int
    public var closedTasks: Int

    public init(totalTasks: Int, closedTasks: Int) {
        self.totalTasks = totalTasks
        self.closedTasks = closedTasks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.totalTasks  = try c.decodeIfPresent(Int.self, forKey: .totalTasks) ?? 0
        self.closedTasks = try c.decodeIfPresent(Int.self, forKey: .closedTasks) ?? 0
    }

    /// `closed / total`, clamped to 0 when the capability has no task beads.
    public var fraction: Double {
        totalTasks > 0 ? Double(closedTasks) / Double(totalTasks) : 0
    }
}

/// One proposal listed under a capability, with its live bead rollup.
/// `specStatus` is `active` (live proposal), `archived`, or `missing`.
public struct RoadmapProposal: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var slug: String
    public var rollup: BeadRollup
    public var specStatus: String

    /// The OpenSpec proposal slug is the natural, stable identity.
    public var id: String { slug }

    public init(slug: String, rollup: BeadRollup, specStatus: String) {
        self.slug = slug
        self.rollup = rollup
        self.specStatus = specStatus
    }
}

/// A `[CAPABILITY]` epic with its child proposals and aggregate progress.
public struct RoadmapCapability: Identifiable, Equatable, Hashable, Codable, Sendable {
    /// Capability name — the epic title minus the `[CAPABILITY] ` prefix.
    public var name: String
    public var epicId: String
    public var epicStatus: String
    public var proposals: [RoadmapProposal]
    public var progress: RoadmapProgress

    /// The capability's epic bead id is its stable identity across renders.
    public var id: String { epicId }

    public init(
        name: String,
        epicId: String,
        epicStatus: String,
        proposals: [RoadmapProposal],
        progress: RoadmapProgress
    ) {
        self.name = name
        self.epicId = epicId
        self.epicStatus = epicStatus
        self.proposals = proposals
        self.progress = progress
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name       = try c.decode(String.self, forKey: .name)
        self.epicId     = try c.decode(String.self, forKey: .epicId)
        self.epicStatus = try c.decode(String.self, forKey: .epicStatus)
        self.proposals  = try c.decodeIfPresent([RoadmapProposal].self, forKey: .proposals) ?? []
        self.progress   = try c.decodeIfPresent(RoadmapProgress.self, forKey: .progress)
            ?? RoadmapProgress(totalTasks: 0, closedTasks: 0)
    }
}

/// Envelope returned by `GET /roadmap?project=`: `{ "capabilities": [...] }`.
/// A missing/empty `capabilities` key decodes to `[]`.
public struct RoadmapResponse: Decodable, Sendable {
    public var capabilities: [RoadmapCapability]

    public init(capabilities: [RoadmapCapability]) {
        self.capabilities = capabilities
    }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        self.capabilities =
            (try? c?.decode([RoadmapCapability].self, forKey: .capabilities)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case capabilities }
}
