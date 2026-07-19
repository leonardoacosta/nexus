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

    /// Title used by the alphabetical sort key.
    var sortTitle: String {
        switch self {
        case .proposal(let p): return p.proposal.slug
        case .orphan(let o):   return o.bead.title
        }
    }
}

/// How the board orders rows WITHIN each group (proposals always group above
/// orphans; this key sorts inside a group). Default is priority.
enum BoardSortKey: String, CaseIterable, Identifiable {
    case priority
    case status
    case title

    var id: String { rawValue }
    var label: String {
        switch self {
        case .priority: return "Priority"
        case .status:   return "Status"
        case .title:    return "Title"
        }
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

    /// Ordering weight for the "Status" sort key (most-actionable first).
    var sortRank: Int {
        switch self {
        case .blocked:    return 0
        case .inProgress: return 1
        case .open:       return 2
        case .closed:     return 3
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
    /// Synthetic rail code that buckets every work item whose `.project` is not
    /// a registered project (a large fraction of orphan beads carry a UUID
    /// instead of a real project code — backend hygiene bug nx-2yy5p.1). One
    /// honest "Unregistered" row instead of thousands of phantom UUID rows.
    static let unregisteredCode = "__unregistered__"

    /// nil = the synthetic "All" row (fleet-wide). Otherwise a project code
    /// (or `unregisteredCode`). Recomputes the memoized visible list on change.
    @Published var selectedProject: String? = nil { didSet { recomputeVisible() } }
    /// Active status filters (chips). Closed is off by default (design § 01).
    @Published var statusFilters: Set<BoardStatus> = [.open, .inProgress, .blocked] { didSet { recomputeVisible() } }
    @Published var orphansOnly: Bool = false { didSet { recomputeVisible() } }
    /// Within-group sort key (proposals always group above orphans).
    @Published var sortKey: BoardSortKey = .priority { didSet { recomputeVisible() } }
    /// The currently selected row (drives the detail rail).
    @Published var selectedItemID: BoardWorkItem.ID?

    @Published private(set) var isLoading = false
    @Published private(set) var allItems: [BoardWorkItem] = []
    /// Memoized visible, filtered, sorted work list. Recomputed once per input
    /// change via `recomputeVisible()`, never per access (was an unmemoized
    /// computed property re-filtering thousands of rows 4+ times per render).
    @Published private(set) var visibleItems: [BoardWorkItem] = []
    @Published private(set) var railProjects: [BoardRailProject] = []
    /// Codes of genuinely registered projects (from the registry, hidden or
    /// not). Drives the `unregisteredCode` bucket collapse.
    @Published private(set) var registeredCodes: Set<String> = []

    private let client = NexusShared.NexusAggregateClient()

    /// The rail bucket an item belongs to: its own project code when that is a
    /// registered project, else the synthetic `unregisteredCode`.
    private func bucketCode(for item: BoardWorkItem) -> String {
        registeredCodes.contains(item.project) ? item.project : Self.unregisteredCode
    }

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

        // A project is "registered" if it exists in the registry (hidden or
        // not). Everything else is a phantom code and collapses into the
        // single `unregisteredCode` bucket below — this is the band-aid for
        // the thousands of UUID-tagged orphan beads (nx-2yy5p.1).
        self.registeredCodes = Set(projects.map(\.name))

        // Rail open-work counts, keyed by rail BUCKET (registered code or the
        // synthetic unregistered code), not by raw project string.
        var openByBucket: [String: Int] = [:]
        for item in items where item.statusBucket != .closed {
            openByBucket[bucketCode(for: item), default: 0] += 1
        }

        // Rail rows: registered (non-hidden) projects. A project with zero
        // open work still shows (design mockup lists `xx 0`).
        let visible = projects.filter { !$0.hidden }
        var rail = visible.map { p in
            BoardRailProject(
                code: p.name,
                name: nil,
                openCount: openByBucket[p.name] ?? 0
            )
        }
        rail.sort {
            if $0.openCount != $1.openCount { return $0.openCount > $1.openCount }
            return $0.code < $1.code
        }
        // Append the single Unregistered bucket last, if any phantom-coded
        // work exists (any status — so it never silently swallows items).
        let unregisteredCount = openByBucket[Self.unregisteredCode] ?? 0
        let hasUnregistered = items.contains { bucketCode(for: $0) == Self.unregisteredCode }
        if hasUnregistered {
            rail.append(BoardRailProject(
                code: Self.unregisteredCode,
                name: "Unregistered",
                openCount: unregisteredCount
            ))
        }
        self.railProjects = rail

        // Derive the memoized visible list from the freshly loaded dataset.
        recomputeVisible()
    }

    /// Total open-work count across the fleet (the "All" rail badge).
    var allOpenCount: Int {
        allItems.filter { $0.statusBucket != .closed }.count
    }

    /// Recompute the memoized visible, filtered, sorted work list for the
    /// current selection. Proposals ALWAYS group above orphans (primary
    /// grouping); `sortKey` orders rows within each group. Invoked once per
    /// input change (load completion + `didSet` of the filter inputs), not per
    /// access.
    func recomputeVisible() {
        visibleItems = allItems
            .filter { item in
                if let sel = selectedProject {
                    if bucketCode(for: item) != sel { return false }
                } else if bucketCode(for: item) == Self.unregisteredCode {
                    // All (nil selection): phantom unregistered-bucket orphans
                    // are scoped OUT of the fleet-wide work list (nx-rk2c4).
                    // They surface only when the synthetic Unregistered rail
                    // row is selected (handled by the `sel` branch above).
                    return false
                }
                if orphansOnly && !item.isOrphan { return false }
                return statusFilters.contains(item.statusBucket)
            }
            .sorted { lhs, rhs in
                // Primary grouping: proposals above orphans.
                if lhs.isOrphan != rhs.isOrphan { return !lhs.isOrphan }
                switch sortKey {
                case .priority:
                    if lhs.priority != rhs.priority { return lhs.priority < rhs.priority }
                case .status:
                    if lhs.statusBucket.sortRank != rhs.statusBucket.sortRank {
                        return lhs.statusBucket.sortRank < rhs.statusBucket.sortRank
                    }
                case .title:
                    let cmp = lhs.sortTitle.localizedCaseInsensitiveCompare(rhs.sortTitle)
                    if cmp != .orderedSame { return cmp == .orderedAscending }
                }
                return lhs.id < rhs.id
            }
    }

    /// Header stat line: proposals · orphans · blocked over the visible set.
    /// One pass over the memoized `visibleItems` (was three re-filters).
    var visibleStats: (proposals: Int, orphans: Int, blocked: Int) {
        var proposals = 0, orphans = 0, blocked = 0
        for item in visibleItems {
            if item.isOrphan { orphans += 1 } else { proposals += 1 }
            if item.statusBucket == .blocked { blocked += 1 }
        }
        return (proposals, orphans, blocked)
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

    /// Toggle selection: re-selecting the open row clears it (closes the
    /// detail rail), otherwise selects it.
    func selectItem(_ id: BoardWorkItem.ID) {
        selectedItemID = (selectedItemID == id) ? nil : id
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
