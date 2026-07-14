// BoardModel — flattened project-structure board data + view model.
//
// Spec: openspec/changes/refocus-board-shell (task 3.1)
//
// The board is a rendering composition over three shipped surfaces —
// `GET /roadmap`, `GET /beads/unlinked`, `GET /specs/.../{file}`. Per design
// § 01 / § 02 it FLATTENS the capability→proposal tree into top-level
// proposal rows (capability demoted to a muted suffix tag), interleaves
// orphan beads (`/beads/unlinked`) at the same top level, and lets the
// project rail be the ONLY selector.
//
// The view model always fetches the fleet-wide `all` variants
// (`fetchRoadmapAll` / `fetchUnlinkedBeadsAll`, refocus-board-shell task 2.5)
// so every capability + orphan arrives tagged with its owning `project`. The
// rail counts and the selected-project filter are then pure client-side
// derivations over that one dataset — matching the design's "selection drives
// the whole board" without a per-project refetch.

import Foundation
import NexusShared

/// A single top-level board row: a live proposal or an unplanned orphan bead.
/// Both render at the same level; the badge distinguishes them (design § 01).
enum BoardWorkItem: Identifiable, Hashable {
    case proposal(BoardProposal)
    case orphan(BoardOrphan)

    var id: String {
        switch self {
        case .proposal(let p): return "proposal:\(p.id)"
        case .orphan(let o):   return "orphan:\(o.id)"
        }
    }

    /// Owning project code — always populated (the `all` fan-out tags every
    /// entry). Drives the rail filter + the muted project tag in All mode.
    var project: String {
        switch self {
        case .proposal(let p): return p.project
        case .orphan(let o):   return o.bead.project ?? p_fallback
        }
    }

    private var p_fallback: String { "?" }

    /// bd priority (0 = broken … 4 = backlog). Board sorts ascending.
    var priority: Int {
        switch self {
        case .proposal(let p): return p.priority
        case .orphan(let o):   return o.bead.priority
        }
    }

    /// Coarse lifecycle bucket used by the status column + the filter chips.
    var statusBucket: BoardStatus {
        switch self {
        case .proposal(let p): return p.statusBucket
        case .orphan(let o):   return BoardStatus(beadStatus: o.bead.status)
        }
    }

    var isOrphan: Bool {
        if case .orphan = self { return true }
        return false
    }
}

/// Coarse lifecycle bucket — the design's Open / In progress / Blocked /
/// Closed status column and the top filter chips.
enum BoardStatus: String, CaseIterable, Identifiable {
    case open
    case inProgress
    case blocked
    case closed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .open:       return "Open"
        case .inProgress: return "In prog"
        case .blocked:    return "Blocked"
        case .closed:     return "Closed"
        }
    }

    /// Map a raw bead status string onto a bucket.
    init(beadStatus raw: String) {
        switch raw.lowercased() {
        case "closed", "done":                        self = .closed
        case "blocked":                               self = .blocked
        case "in_progress", "in-progress", "active":  self = .inProgress
        default:                                       self = .open
        }
    }
}

/// A proposal flattened out of its capability. `capabilityName` is the muted
/// suffix tag (design § 01 — the proposal is the triage unit, the capability
/// is a tag). `project` is resolved from the owning capability's `project`
/// tag (fleet fan-out) or the caller's selected code.
struct BoardProposal: Identifiable, Hashable {
    let project: String
    let capabilityName: String
    let proposal: RoadmapProposal

    var id: String { "\(project)/\(proposal.slug)" }
    var rollup: BeadRollup { proposal.rollup }

    var priority: Int {
        proposal.rollup.feature?.priority
            ?? proposal.rollup.epic?.priority
            ?? 2
    }

    /// Derived lifecycle bucket: blocked beads win, then all-closed, then any
    /// progress, else open. Spec status "archived" also reads as closed.
    var statusBucket: BoardStatus {
        let t = proposal.rollup.tasks
        if t.blocked > 0 { return .blocked }
        if proposal.specStatus.lowercased() == "archived" { return .closed }
        if t.total > 0 && t.closed >= t.total { return .closed }
        if t.closed > 0 || proposal.specStatus.lowercased() == "active" {
            return .inProgress
        }
        return .open
    }
}

/// An orphan bead row (`/beads/unlinked`). Carries the tagged project +
/// optional one-line description (refocus-board-shell task 2.5).
struct BoardOrphan: Identifiable, Hashable {
    let bead: UnlinkedBead
    var id: String { bead.id }
}

/// One rail entry — a registered project plus its live open-work count.
struct BoardRailProject: Identifiable, Hashable {
    let code: String
    let name: String?
    let openCount: Int
    var id: String { code }
}

@MainActor
final class BoardViewModel: ObservableObject {
    /// nil = the synthetic "All" row (fleet-wide). Otherwise a project code.
    @Published var selectedProject: String? = nil
    /// Active status filters (chips). Closed is off by default (design § 01).
    @Published var statusFilters: Set<BoardStatus> = [.open, .inProgress, .blocked]
    @Published var orphansOnly: Bool = false
    /// The currently selected row (drives the detail rail).
    @Published var selectedItemID: BoardWorkItem.ID?

    @Published private(set) var isLoading = false
    @Published private(set) var allItems: [BoardWorkItem] = []
    @Published private(set) var railProjects: [BoardRailProject] = []

    private let client = NexusShared.NexusAggregateClient()

    /// Fleet-wide load: roadmap + unlinked over every non-hidden project, plus
    /// the registry list for the rail. One fetch powers both the rail counts
    /// and the (client-side filtered) work list.
    func load() async {
        isLoading = true
        defer { isLoading = false }

        async let capsTask = client.fetchRoadmapAll()
        async let orphansTask = client.fetchUnlinkedBeadsAll()
        async let projectsTask = client.fetchProjects()
        let (caps, orphans, projects) = await (capsTask, orphansTask, projectsTask)

        var items: [BoardWorkItem] = []
        for cap in caps {
            let proj = cap.project ?? "?"
            for prop in cap.proposals {
                items.append(.proposal(BoardProposal(
                    project: proj,
                    capabilityName: cap.name,
                    proposal: prop
                )))
            }
        }
        for bead in orphans {
            items.append(.orphan(BoardOrphan(bead: bead)))
        }
        self.allItems = items

        // Rail rows: registered (non-hidden) projects + an open-work count
        // derived from the loaded items. A project with zero open work still
        // shows (design mockup lists `xx 0`).
        var openByProject: [String: Int] = [:]
        for item in items where item.statusBucket != .closed {
            openByProject[item.project, default: 0] += 1
        }
        let visible = projects.filter { !$0.hidden }
        var rail = visible.map { p in
            BoardRailProject(
                code: p.name,
                name: nil,
                openCount: openByProject[p.name] ?? 0
            )
        }
        // Include any project that has open work but no registry row (safety
        // net so orphaned work is never invisible).
        let known = Set(rail.map(\.code))
        for (code, count) in openByProject where !known.contains(code) {
            rail.append(BoardRailProject(code: code, name: nil, openCount: count))
        }
        self.railProjects = rail.sorted {
            if $0.openCount != $1.openCount { return $0.openCount > $1.openCount }
            return $0.code < $1.code
        }
    }

    /// Total open-work count across the fleet (the "All" rail badge).
    var allOpenCount: Int {
        allItems.filter { $0.statusBucket != .closed }.count
    }

    /// The visible, filtered, sorted work list for the current selection.
    var visibleItems: [BoardWorkItem] {
        allItems
            .filter { item in
                if let sel = selectedProject, item.project != sel { return false }
                if orphansOnly && !item.isOrphan { return false }
                return statusFilters.contains(item.statusBucket)
            }
            .sorted { lhs, rhs in
                if lhs.priority != rhs.priority { return lhs.priority < rhs.priority }
                // Proposals above orphans at equal priority, then by id.
                if lhs.isOrphan != rhs.isOrphan { return !lhs.isOrphan }
                return lhs.id < rhs.id
            }
    }

    /// Header stat line: proposals · orphans · blocked over the visible set.
    var visibleStats: (proposals: Int, orphans: Int, blocked: Int) {
        let v = visibleItems
        return (
            v.filter { !$0.isOrphan }.count,
            v.filter { $0.isOrphan }.count,
            v.filter { $0.statusBucket == .blocked }.count
        )
    }

    func toggleFilter(_ status: BoardStatus) {
        if statusFilters.contains(status) {
            statusFilters.remove(status)
        } else {
            statusFilters.insert(status)
        }
    }

    func selectedItem() -> BoardWorkItem? {
        guard let id = selectedItemID else { return nil }
        return allItems.first { $0.id == id }
    }

    // MARK: - Detail-content prefetch

    /// How many visible proposal rows to eagerly warm (spec: N = 20, in-order).
    nonisolated static let prefetchLimit = 20

    /// Prefetch targets for the current visible list.
    func prefetchKeys(limit: Int = BoardViewModel.prefetchLimit) -> [SpecContentCache.CacheKey] {
        BoardViewModel.prefetchKeys(from: visibleItems, limit: limit)
    }

    /// Pure, testable core: the DEFAULT (`proposal`) tab of the first `limit`
    /// `.proposal` rows in `items`, in list order. Orphan rows carry no spec
    /// content and are skipped; `design`/`tasks` tabs are never eagerly warmed
    /// (spec Scope: OUT).
    nonisolated static func prefetchKeys(
        from items: [BoardWorkItem],
        limit: Int = BoardViewModel.prefetchLimit
    ) -> [SpecContentCache.CacheKey] {
        Array(
            items
                .compactMap { item -> SpecContentCache.CacheKey? in
                    guard case .proposal(let p) = item else { return nil }
                    return SpecContentCache.CacheKey(
                        project: p.project,
                        slug: p.proposal.slug,
                        file: SpecDocTab.proposal.rawValue
                    )
                }
                .prefix(limit)
        )
    }

    /// Kick bounded background prefetches for the visible proposal rows. Runs
    /// off the main actor in a detached-from-UI `Task` so it never blocks
    /// rendering; rows already `.fresh` or in-flight are skipped inside the
    /// cache. Called on `visibleItems` change (filter / sort / project select).
    func prefetchVisible(into cache: SpecContentCache = .shared) {
        let keys = prefetchKeys()
        guard !keys.isEmpty else { return }
        let client = self.client
        Task {
            for key in keys {
                await cache.prefetch(key: key, using: { k in
                    await client.fetchSpecContent(project: k.project, name: k.slug, file: k.file)
                })
            }
        }
    }
}
