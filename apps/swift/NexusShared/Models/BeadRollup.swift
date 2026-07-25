// BeadRollup — Codable mirror of the agent's per-proposal bead rollup.
//
// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.1)
//
// Source of truth: packages/core/src/types/spec.ts
// (`BeadRef` / `BeadRollup` / `UnlinkedBead`) plus the runtime aggregator in
// apps/agent/src/services/bead-rollup.ts.
//
// The wire JSON is camelCase, so these structs use synthesized CodingKeys —
// no custom key mapping needed. The nested task-count struct carries a
// tolerant decoder (decodeIfPresent ?? 0) so an older agent that omits a
// count decodes to 0 rather than throwing, mirroring the `?? false` wire
// discipline in SpecSummary / specs.ts.
//
// Cross-platform: no AppKit / UIKit imports so iOS + watchOS can adopt the
// same decoder in a follow-up without a wire change (design.md § Non-goals).

import Foundation

/// A single linked bead, as surfaced inside a `BeadRollup`. `type` mirrors
/// bd's `issue_type` field (epic | feature | task | bug | chore).
public struct BeadRef: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: String
    public var status: String
    public var type: String
    public var priority: Int
    public var title: String
    /// One-line bead description, when present. Additive optional (source:
    /// packages/core/src/types/spec.ts `BeadRef.description?`, populated from
    /// `bd list --json` and omitted when empty). Synthesized Decodable treats
    /// a missing key as nil, so older agents decode unchanged.
    public var description: String?

    public init(
        id: String,
        status: String,
        type: String,
        priority: Int,
        title: String,
        description: String? = nil
    ) {
        self.id = id
        self.status = status
        self.type = type
        self.priority = priority
        self.title = title
        self.description = description
    }
}

/// Task-bead counts for one proposal. Task beads ONLY (epic + feature
/// excluded) so a 14-task proposal reads `x/14`, matching `bd epic status`.
/// Non-optional `Int` counts; the tolerant decoder defaults a missing key to
/// 0 so an older agent can't 500 the decode.
public struct BeadTaskCounts: Equatable, Hashable, Codable, Sendable {
    public var total: Int
    public var closed: Int
    public var ready: Int
    public var blocked: Int

    public init(total: Int, closed: Int, ready: Int, blocked: Int) {
        self.total = total
        self.closed = closed
        self.ready = ready
        self.blocked = blocked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.total   = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        self.closed  = try c.decodeIfPresent(Int.self, forKey: .closed) ?? 0
        self.ready   = try c.decodeIfPresent(Int.self, forKey: .ready) ?? 0
        self.blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
    }
}

/// Per-proposal bead rollup computed live from the `beads:epic` /
/// `beads:feature` / `[beads:<id>]` markers in the proposal's `tasks.md`.
/// `beads` carries the full linked set (epic + feature + tasks) for the
/// detail view; `tasks` counts task beads only.
public struct BeadRollup: Equatable, Hashable, Codable, Sendable {
    public var epic: BeadRef?
    public var feature: BeadRef?
    public var tasks: BeadTaskCounts
    public var beads: [BeadRef]

    public init(
        epic: BeadRef? = nil,
        feature: BeadRef? = nil,
        tasks: BeadTaskCounts,
        beads: [BeadRef] = []
    ) {
        self.epic = epic
        self.feature = feature
        self.tasks = tasks
        self.beads = beads
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.epic    = try c.decodeIfPresent(BeadRef.self, forKey: .epic)
        self.feature = try c.decodeIfPresent(BeadRef.self, forKey: .feature)
        self.tasks   = try c.decodeIfPresent(BeadTaskCounts.self, forKey: .tasks)
            ?? BeadTaskCounts(total: 0, closed: 0, ready: 0, blocked: 0)
        self.beads   = try c.decodeIfPresent([BeadRef].self, forKey: .beads) ?? []
    }

    /// `closed / total`, clamped to 0 when the proposal has no task beads.
    public var progress: Double {
        tasks.total > 0 ? Double(tasks.closed) / Double(tasks.total) : 0
    }
}

/// A bead with no proposal link — unplanned open work surfaced by
/// `GET /beads/unlinked?project=<code>`.
public struct UnlinkedBead: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: String
    public var title: String
    public var status: String
    public var priority: Int
    public var type: String
    /// Owning project code — populated ONLY on the `project=all` fan-out
    /// (additive; single-project responses omit the key → nil).
    public var project: String?
    /// One-line bead description, when present. Additive optional (source:
    /// packages/core/src/types/spec.ts `UnlinkedBead.description?`). Synthesized
    /// Decodable treats a missing key as nil, so older agents decode unchanged.
    public var description: String?

    public init(
        id: String,
        title: String,
        status: String,
        priority: Int,
        type: String,
        project: String? = nil,
        description: String? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.priority = priority
        self.type = type
        self.project = project
        self.description = description
    }
}

/// Envelope returned by `GET /beads/unlinked?project=`:
/// `{ "unlinked": [...] }`. A missing/empty `unlinked` key decodes to `[]`.
public struct UnlinkedBeadsResponse: Decodable, Sendable {
    public var unlinked: [UnlinkedBead]

    public init(unlinked: [UnlinkedBead]) {
        self.unlinked = unlinked
    }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        self.unlinked =
            (try? c?.decode([UnlinkedBead].self, forKey: .unlinked)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case unlinked }
}

// ci-scratch: self-hosted runner verification (temporary, scratch branch only)
