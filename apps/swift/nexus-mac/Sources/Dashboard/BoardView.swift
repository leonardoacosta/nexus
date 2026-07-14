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

    var body: some View {
        HStack(spacing: 0) {
            rail
                .frame(width: 208)
            Divider().overlay(Color.nx.hairline)
            board
                .frame(maxWidth: .infinity)
            Divider().overlay(Color.nx.hairline)
            BoardDetailRail(
                item: model.selectedItem(),
                sessions: observer.activeSessions,
                notifications: observer.notifications,
                lastBeadTransition: observer.lastBeadTransition,
                onAttach: { attachSession = $0 }
            )
            .frame(width: 322)
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
    }

    // MARK: - Rail

    private var rail: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PROJECTS")
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .tracking(2.2)
                .foregroundStyle(Color.nx.ink4)
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
            railFoot
        }
        .background(Color.nx.substrate2)
    }

    private func railRow(code: String?, name: String?, count: Int) -> some View {
        let active = model.selectedProject == code
        return Button {
            model.selectedProject = code
            model.selectedItemID = nil
        } label: {
            HStack(spacing: 8) {
                Text(code ?? "All")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(active ? Color.nx.ink : Color.nx.ink2)
                if let name, code != nil {
                    Text(name)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.nx.ink4)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("\(count)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(count > 0 ? Color.nx.amber : Color.nx.ink4)
            }
            .padding(.horizontal, active ? 16 : 18)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                active
                    ? LinearGradient(
                        colors: [Color.nx.phosphor.opacity(0.08), .clear],
                        startPoint: .leading, endPoint: .trailing)
                    : LinearGradient(colors: [.clear], startPoint: .leading, endPoint: .trailing)
            )
            .overlay(alignment: .leading) {
                if active {
                    Rectangle().fill(Color.nx.phosphor).frame(width: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("board-rail-\(code ?? "all")")
    }

    private var railFoot: some View {
        let live = observer.activeSessions.count
        return VStack(alignment: .leading, spacing: 3) {
            Divider().overlay(Color.nx.hairline)
            Text("\(live) session\(live == 1 ? "" : "s") live")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(Color.nx.ink3)
            if let first = observer.activeSessions.first {
                Text(Session.projectLabel(for: first))
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(Color.nx.ink4)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .padding(.bottom, 14)
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
                                onSelect: { model.selectedItemID = item.id }
                            )
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 16)
                }
            }
        }
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
            Text("\(stats.proposals) proposals · \(stats.orphans) orphans · \(stats.blocked) blocked")
                .font(.system(size: 10.5, design: .monospaced))
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
        .background(Color.nx.substrate2)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(selected ? Color.nx.phosphorDim : Color.nx.hairline, lineWidth: 1)
        )
    }

    private var head: some View {
        HStack(spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(expanded ? Color.nx.phosphor : Color.nx.ink4)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .buttonStyle(.plain)
            .frame(width: 14)

            Text(bid)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.cyan)
                .frame(width: 84, alignment: .leading)

            BoardBadge(kind: badgeKind)

            HStack(spacing: 6) {
                if showProjectTag {
                    Text(item.project)
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(.purple)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .overlay(RoundedRectangle(cornerRadius: 3).stroke(.purple.opacity(0.4)))
                }
                Text(title)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Color.nx.ink)
                    .lineLimit(1).truncationMode(.tail)
                if let cap = capabilityTag {
                    Text("· \(cap)")
                        .font(.system(size: 10, design: .monospaced))
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
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .background(selected ? Color.nx.substrate3 : Color.clear)
        .accessibilityIdentifier("board-row-\(item.id)")
    }

    @ViewBuilder
    private var progressCell: some View {
        if case .proposal(let p) = item {
            let t = p.rollup.tasks
            HStack(spacing: 6) {
                ProgressView(value: p.rollup.progress)
                    .progressViewStyle(.linear)
                    .tint(t.blocked > 0 ? Color.nx.amber : Color.nx.phosphor)
                Text("\(t.closed)/\(t.total)")
                    .font(.system(size: 9.5, design: .monospaced))
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
        case .proposal: return Color.nx.phosphor
        case .task:     return .cyan
        case .bug:      return Color.nx.critical
        case .orphan:   return Color.nx.amber
        }
    }
}

struct BoardBadge: View {
    let kind: BoardBadgeKind
    var body: some View {
        Text(kind.label.uppercased())
            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
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
            .font(.system(size: 9.5, weight: .bold, design: .monospaced))
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
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(1)
            .foregroundStyle(color)
    }
    private var color: Color {
        switch status {
        case .inProgress: return Color.nx.phosphor
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
                .font(.system(size: 10, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(on ? Color.nx.phosphor : Color.nx.ink3)
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(on ? Color.nx.phosphor.opacity(0.08) : .clear)
                .overlay(Capsule().stroke(on ? Color.nx.phosphorDim : Color.nx.hairlineStrong))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
