// BoardView — the project-structure board (design § 01).
//
// Spec: openspec/changes/refocus-board-shell (task 3.1)
//
// Three columns: project rail (the only selector) · flattened work list
// (proposals as first-class rows, orphan beads interleaved at the same level)
// · detail rail. The titlebar + TTS ticker live one level up in AppNavigation
// (task 3.2); BoardView is the frame body.

import SwiftUI
import NexusShared

struct BoardView: View {
    @ObservedObject var observer: SessionObserver
    @StateObject private var model = BoardViewModel()
    @State private var attachSession: Session?
    @State private var showProjectManager = false

    /// Spring used for the detail-rail open/close.
    private let detailSpring = Animation.spring(response: 0.4, dampingFraction: 0.82)

    var body: some View {
        HStack(spacing: 0) {
            rail
                .frame(width: 208)
            Divider().overlay(Color.nx.hairline)
            board
                .frame(maxWidth: .infinity)
            // The detail rail is present ONLY when a row is selected; it
            // animates in from the trailing edge and out on deselect.
            if let item = model.selectedItem() {
                Divider().overlay(Color.nx.hairline)
                BoardDetailRail(
                    item: item,
                    allItems: model.allItems,
                    sessions: observer.activeSessions,
                    notifications: observer.notifications,
                    lastBeadTransition: observer.lastBeadTransition,
                    onAttach: { attachSession = $0 },
                    onSelectSibling: { id in
                        withAnimation(detailSpring) { model.selectedItemID = id }
                    }
                )
                .frame(width: 322)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .background(Color.nx.substrate)
        .task { await model.load() }
        .refreshable { await model.load() }
        // Eagerly warm the detail-content cache for the visible proposal rows
        // whenever the list changes (filter / sort / project select / initial
        // load). Bounded to the first 20 proposals inside the model.
        .onChange(of: model.visibleItems) { _, _ in
            model.prefetchVisible()
        }
        .sheet(item: $attachSession) { session in
            AttachSheet(session: session)
        }
        .sheet(isPresented: $showProjectManager) {
            ProjectManagerSheet()
        }
    }

    // MARK: - Rail

    private var rail: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("PROJECTS")
                    .font(Font.nx.ui(9.5, weight: .semibold))
                    .tracking(2.2)
                    .foregroundStyle(Color.nx.ink4)
                Spacer(minLength: 0)
                Button {
                    showProjectManager = true
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.nx.ink3)
                }
                .buttonStyle(.plain)
                .help("Manage projects — show or hide registered projects")
                .accessibilityIdentifier("board-rail-manage-projects")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            ScrollView {
                LazyVStack(spacing: 0) {
                    railRow(code: nil, name: "All", count: model.allOpenCount)
                    ForEach(model.railProjects) { p in
                        railRow(code: p.code, name: p.name, count: p.openCount)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .background(.ultraThinMaterial)
    }

    private func railRow(code: String?, name: String?, count: Int) -> some View {
        let active = model.selectedProject == code
        // The synthetic Unregistered bucket shows its label, not a code.
        let isUnregistered = code == BoardViewModel.unregisteredCode
        let title = isUnregistered ? (name ?? "Unregistered") : (code ?? "All")
        return Button {
            withAnimation(detailSpring) {
                model.selectedProject = code
                model.selectedItemID = nil
            }
        } label: {
            HStack(spacing: 8) {
                Text(title)
                    .font(isUnregistered ? Font.nx.ui(12, weight: .semibold)
                                         : Font.nx.code(12, weight: .semibold))
                    .foregroundStyle(active ? Color.nx.ink : Color.nx.ink2)
                    .lineLimit(1)
                if let name, code != nil, !isUnregistered {
                    Text(name)
                        .font(Font.nx.ui(11))
                        .foregroundStyle(Color.nx.ink4)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("\(count)")
                    .font(Font.nx.code(10))
                    .foregroundStyle(count > 0 ? Color.nx.amber : Color.nx.ink4)
            }
            .padding(.horizontal, active ? 16 : 18)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? Color.accentColor.opacity(0.12) : .clear)
            .overlay(alignment: .leading) {
                if active {
                    Rectangle().fill(Color.accentColor).frame(width: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("board-rail-\(code ?? "all")")
    }

    // MARK: - Board list

    private var board: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar
            if model.visibleItems.isEmpty {
                ContentUnavailableView(
                    model.isLoading ? "Loading…" : "No work here",
                    systemImage: "tray",
                    description: Text(
                        model.isLoading
                            ? "Fetching roadmap + orphan beads across the fleet."
                            : "No proposals or orphan beads match the current filters."
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(model.visibleItems) { item in
                            BoardRow(
                                item: item,
                                showProjectTag: model.selectedProject == nil,
                                selected: model.selectedItemID == item.id,
                                onSelect: {
                                    withAnimation(detailSpring) { model.selectItem(item.id) }
                                }
                            )
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .move(edge: .top)),
                                removal: .opacity
                            ))
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 16)
                    // Single container-level animation keyed to the memoized
                    // array: one Equatable comparison per change instead of the
                    // former per-row O(rows x arraySize) whole-array compare.
                    .animation(
                        .spring(response: 0.35, dampingFraction: 0.85),
                        value: model.visibleItems
                    )
                }
            }
        }
        .background(.regularMaterial)
    }

    private var filterBar: some View {
        let stats = model.visibleStats
        return HStack(spacing: 8) {
            ForEach(BoardStatus.allCases) { status in
                FilterChip(
                    label: status.label,
                    on: model.statusFilters.contains(status),
                    action: { model.toggleFilter(status) }
                )
            }
            FilterChip(
                label: "Orphans only",
                on: model.orphansOnly,
                action: { model.orphansOnly.toggle() }
            )
            Spacer()
            Picker("Sort", selection: $model.sortKey) {
                ForEach(BoardSortKey.allCases) { key in
                    Text(key.label).tag(key)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(width: 108)
            .accessibilityIdentifier("board-sort-key")
            Text("\(stats.proposals) proposals · \(stats.orphans) orphans · \(stats.blocked) blocked")
                .font(Font.nx.code(10.5))
                .foregroundStyle(Color.nx.ink3)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }
}

// MARK: - Row

private struct BoardRow: View {
    let item: BoardWorkItem
    let showProjectTag: Bool
    let selected: Bool
    let onSelect: () -> Void
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            head
            if expanded { kids }
        }
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(selected ? Color.accentColor : Color.nx.hairline, lineWidth: 1)
        )
    }

    private var head: some View {
        HStack(spacing: 12) {
            Text(bid)
                .font(Font.nx.code(11))
                .foregroundStyle(Color.nx.ink3)
                .frame(width: 84, alignment: .leading)

            BoardBadge(kind: badgeKind)

            HStack(spacing: 6) {
                if showProjectTag {
                    Text(item.project)
                        .font(Font.nx.code(9, weight: .medium))
                        .foregroundStyle(Color.accentColor)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.accentColor.opacity(0.4)))
                }
                Text(title)
                    .font(Font.nx.ui(12.5))
                    .foregroundStyle(Color.nx.ink)
                    .lineLimit(1).truncationMode(.tail)
                if let cap = capabilityTag {
                    Text("· \(cap)")
                        .font(Font.nx.ui(10))
                        .foregroundStyle(Color.nx.ink4)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            progressCell
                .frame(width: 130)

            StatusLabel(status: item.statusBucket)
                .frame(width: 58)

            PriorityPill(priority: item.priority)
                .frame(width: 40)

            // Chevron moved to the rightmost position — toggles the inline
            // task/description kids independently of row selection.
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(expanded ? Color.accentColor : Color.nx.ink4)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .buttonStyle(.plain)
            .frame(width: 14)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .background(selected ? Color.accentColor.opacity(0.08) : Color.clear)
        .accessibilityIdentifier("board-row-\(item.id)")
    }

    @ViewBuilder
    private var progressCell: some View {
        if case .proposal(let p) = item {
            let t = p.rollup.tasks
            HStack(spacing: 6) {
                ProgressView(value: p.rollup.progress)
                    .progressViewStyle(.linear)
                    .tint(t.blocked > 0 ? Color.nx.amber : Color.accentColor)
                Text("\(t.closed)/\(t.total)")
                    .font(Font.nx.code(9.5))
                    .foregroundStyle(Color.nx.ink3)
            }
        } else {
            Spacer()
        }
    }

    @ViewBuilder
    private var kids: some View {
        Divider().overlay(Color.nx.hairline)
        VStack(alignment: .leading, spacing: 4) {
            switch item {
            case .proposal(let p):
                let taskBeads = p.rollup.beads.filter { $0.type == "task" }
                if taskBeads.isEmpty {
                    Text("No linked task beads.")
                        .font(.caption2).foregroundStyle(Color.nx.ink4)
                } else {
                    ForEach(taskBeads.prefix(20)) { bead in
                        HStack(spacing: 8) {
                            BeadStatusGlyph(status: bead.status)
                            Text(bead.id).font(.caption2.monospaced())
                                .foregroundStyle(Color.nx.ink3)
                            Text(bead.title).font(.caption2)
                                .foregroundStyle(bead.status.lowercased() == "closed" ? Color.nx.ink4 : Color.nx.ink2)
                                .strikethrough(bead.status.lowercased() == "closed", color: Color.nx.hairlineStrong)
                                .lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 0)
                        }
                    }
                }
            case .orphan(let o):
                Text(o.bead.description ?? "Unplanned — not referenced by any live proposal's tasks.md.")
                    .font(.caption2)
                    .foregroundStyle(Color.nx.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 40)
        .padding(.vertical, 8)
    }

    private var bid: String {
        switch item {
        case .proposal(let p): return p.rollup.epic?.id ?? p.rollup.feature?.id ?? p.proposal.slug
        case .orphan(let o):   return o.bead.id
        }
    }

    private var title: String {
        switch item {
        case .proposal(let p): return p.proposal.slug
        case .orphan(let o):   return o.bead.title
        }
    }

    private var capabilityTag: String? {
        if case .proposal(let p) = item { return p.capabilityName }
        return nil
    }

    private var badgeKind: BoardBadgeKind {
        switch item {
        case .proposal: return .proposal
        case .orphan(let o): return o.bead.type.lowercased() == "bug" ? .bug : .orphan
        }
    }
}

// MARK: - Small components

enum BoardBadgeKind {
    case proposal, task, bug, orphan
    var label: String {
        switch self {
        case .proposal: return "Proposal"
        case .task:     return "Task"
        case .bug:      return "Bug"
        case .orphan:   return "Orphan"
        }
    }
    var color: Color {
        switch self {
        case .proposal: return Color.accentColor
        case .task:     return Color.accentColor
        case .bug:      return Color.nx.critical
        case .orphan:   return Color.nx.amber
        }
    }
}

struct BoardBadge: View {
    let kind: BoardBadgeKind
    var body: some View {
        Text(kind.label.uppercased())
            .font(Font.nx.ui(8.5, weight: .bold))
            .tracking(1.2)
            .foregroundStyle(kind.color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(kind.color.opacity(0.10))
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(kind.color.opacity(0.5)))
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

struct PriorityPill: View {
    let priority: Int
    var body: some View {
        Text("P\(priority)")
            .font(Font.nx.code(9.5, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .frame(maxWidth: .infinity)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
    private var color: Color {
        switch priority {
        case 0:  return Color.nx.critical
        case 1:  return Color.nx.amber
        case 2:  return .cyan
        default: return Color.nx.ink3
        }
    }
}

struct StatusLabel: View {
    let status: BoardStatus
    var body: some View {
        Text(status.label.uppercased())
            .font(Font.nx.ui(9, weight: .bold))
            .tracking(1)
            .foregroundStyle(color)
    }
    private var color: Color {
        switch status {
        case .inProgress: return Color.accentColor
        case .open:       return Color.nx.ink3
        case .blocked:    return Color.nx.critical
        case .closed:     return Color.nx.ink4
        }
    }
}

struct FilterChip: View {
    let label: String
    let on: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label.uppercased())
                .font(Font.nx.ui(10))
                .tracking(0.8)
                .foregroundStyle(on ? Color.accentColor : Color.nx.ink3)
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(on ? Color.accentColor.opacity(0.10) : .clear)
                .overlay(Capsule().stroke(on ? Color.accentColor : Color.nx.hairlineStrong))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
