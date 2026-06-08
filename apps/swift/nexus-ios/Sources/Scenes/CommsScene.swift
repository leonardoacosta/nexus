// CommsScene (mx-1ezh) — the COMMS archetype list. One template renders six
// sources / four kinds (gmail+outlook EMAIL, teams+imessage CHAT, ado WORK_ITEM,
// snow TICKET). Spine = Core.*, payload = CommsBody.*. READ-ONLY.
//
// Design: ~/dev/mx/docs/nx-ui/nx-wireframe-comms.html (iOS compact panel).
// All/Mine/Waiting segmented filter; rows show avatar + kind glyph, title,
// summary, ball-in-court + priority + disposition pills, relative activity.
// Same-threadKey rows collapse with "+N"; dormant rows dim. Tap -> DetailScene.

import SwiftUI
import NexusShared

struct CommsScene: View {
    @ObservedObject var observer: TriageObserver
    @State private var filter: CommsFilter = .all

    enum CommsFilter: String, CaseIterable { case all = "All", mine = "Mine", waiting = "Waiting" }

    var body: some View {
        List {
            Section {
                Picker("Filter", selection: $filter) {
                    ForEach(CommsFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("comms-filter")
                .listRowBackground(Color.clear)
            }
            if observer.isSampleData {
                Section { SampleCaptionRow(id: "comms-sample-caption") }
            }
            Section {
                if rows.isEmpty {
                    ContentUnavailableView("No comms", systemImage: "tray",
                                           description: Text("Nothing matches this filter."))
                } else {
                    ForEach(rows) { group in
                        NavigationLink(value: group.lead) {
                            CommsRow(group: group)
                        }
                    }
                }
            } footer: {
                Text("\(observer.mine.count) asks need attention")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Comms")
        .navigationDestination(for: TriageItem.self) { DetailScene(item: $0) }
        .accessibilityIdentifier("comms-scene")
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
    }

    /// Filtered + thread-collapsed groups.
    private var rows: [CommsGroup] {
        let filtered = observer.comms.filter {
            switch filter {
            case .all: return true
            case .mine: return $0.ballInCourt == .mine
            case .waiting: return $0.payload.comms?.suggestedDisposition == .waiting
                || $0.ballInCourt == .theirs
            }
        }
        // Collapse by threadKey: lead = most recent, count siblings.
        var seen: [String: Int] = [:]
        var groups: [CommsGroup] = []
        for item in filtered {
            let key = item.threadKey ?? item.id
            if let idx = seen[key] {
                groups[idx].extra += 1
            } else {
                seen[key] = groups.count
                groups.append(CommsGroup(lead: item, extra: 0))
            }
        }
        return groups
    }
}

struct CommsGroup: Identifiable {
    let lead: TriageItem
    var extra: Int
    var id: String { lead.id }
}

private struct CommsRow: View {
    let group: CommsGroup
    private var item: TriageItem { group.lead }
    private var body0: CommsBody? { item.payload.comms }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: item.author?.displayName ?? item.source)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: KindGlyph.symbol(for: item.kind))
                        .font(.caption).foregroundStyle(.secondary)
                    Text(item.author?.displayName ?? item.source)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(TriageFormat.ago(item.lastActivityAt))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    Text(item.title).font(.body).lineLimit(1)
                    if group.extra > 0 {
                        Text("+\(group.extra)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.blue)
                    }
                }
                if let summary = body0?.summary {
                    Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 5) {
                    BallChip(ball: item.ballInCourt)
                    if let p = body0?.priority { PriorityChip(priority: p) }
                    if let d = body0?.suggestedDisposition { OutlinePill(text: d.label, tint: .blue) }
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(item.stillPresentUpstream ? 1 : 0.5)
        .accessibilityIdentifier("comms-row-\(item.id)")
    }
}

#if DEBUG
#Preview("Comms (sample)") {
    NavigationStack {
        CommsScene(observer: {
            let o = TriageObserver(); o.setItemsForPreview(TriageItem.sampleData, isSample: true); return o
        }())
    }
}
#endif
