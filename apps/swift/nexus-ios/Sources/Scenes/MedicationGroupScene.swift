// MedicationGroupScene (mx-ieau) — the Meds tab PRIMARY view.
//
// Capability: src-meds (mx-t66o). The MAIN surface is the adherence/misses
// triage (per design § "Served representation": misses/adherence is the MAIN
// view, the per-dose logbook is History). Layout:
//   - "TAKE LAST GROUP" hero button (decision b) on top.
//   - Adherence rail: per-group taken/skipped/MISSED counts, misses highlighted.
//   - Group manager (add / delete / merge) + per-member actions reachable via
//     a NavigationLink into MedicationGroupDetailScene.
//   - History feed + add-med form reachable from the toolbar.
//
// Per-med action priority (decision d): tap a member = adjust the dose,
// long-press / menu = opt-out + change standing default. Those live in the
// group-detail subview where the member rows render.
//
// Data: MedsObserver (meds sidecar :8802). Endpoints are LIVE in mx, so a
// transport error surfaces as an error state (not a sample fallback).

import SwiftUI
import NexusShared

struct MedicationGroupScene: View {
    @ObservedObject var observer: MedsObserver

    @State private var showAddMed = false
    @State private var showGroupManager = false
    @State private var mergeFrom: MedGroup?

    var body: some View {
        List {
            Section { TakeLastGroupHero(observer: observer) }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))

            switch observer.phase {
            case .loading where observer.adherence.isEmpty:
                Section { LoadingRow() }
            case .error(let message) where observer.adherence.isEmpty:
                Section { ErrorRow(message: message) { Task { await observer.refresh() } } }
            default:
                adherenceSection
                groupsSection
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Meds")
        .accessibilityIdentifier("meds-scene")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    NavigationLink {
                        MedicationHistoryScene(observer: observer)
                    } label: { Label("History", systemImage: "list.bullet.rectangle") }
                    Button { showAddMed = true } label: {
                        Label("Add Medication", systemImage: "pills.circle")
                    }
                    Button { showGroupManager = true } label: {
                        Label("New Group", systemImage: "plus.rectangle.on.folder")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityIdentifier("meds-menu")
            }
        }
        .sheet(isPresented: $showAddMed) {
            AddMedicationSheet(observer: observer)
        }
        .sheet(isPresented: $showGroupManager) {
            NewGroupSheet(observer: observer)
        }
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
        .refreshable { await observer.refresh() }
    }

    // MARK: - Sections

    private var adherenceSection: some View {
        Group {
            if observer.adherence.isEmpty {
                Section("Adherence") {
                    ContentUnavailableView(
                        "No adherence data",
                        systemImage: "checkmark.seal",
                        description: Text("Log a group to start tracking misses."))
                }
            } else {
                if !flaggedAdherence.isEmpty {
                    Section {
                        ForEach(flaggedAdherence) { a in AdherenceRow(adherence: a, flagged: true) }
                    } header: {
                        Label("Misses · \(missedTotal) to review", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                Section("Adherence (7 days)") {
                    ForEach(onTrackAdherence) { a in AdherenceRow(adherence: a, flagged: false) }
                }
            }
        }
    }

    private var groupsSection: some View {
        Section("Groups") {
            if observer.groups.isEmpty {
                ContentUnavailableView(
                    "No groups",
                    systemImage: "rectangle.stack.badge.plus",
                    description: Text("Create a time-of-day group to log doses together."))
            } else {
                ForEach(observer.groups) { group in
                    NavigationLink {
                        MedicationGroupDetailScene(observer: observer, groupId: group.id)
                    } label: {
                        GroupRow(group: group)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await observer.deleteGroup(group.id) }
                        } label: { Label("Delete", systemImage: "trash") }
                        Button {
                            mergeFrom = group
                        } label: { Label("Merge", systemImage: "arrow.triangle.merge") }
                            .tint(.indigo)
                    }
                }
            }
        }
        .confirmationDialog(
            "Merge \(mergeFrom?.name ?? "") into…",
            isPresented: Binding(get: { mergeFrom != nil }, set: { if !$0 { mergeFrom = nil } }),
            titleVisibility: .visible
        ) {
            ForEach(mergeTargets) { target in
                Button(target.name) {
                    if let from = mergeFrom {
                        Task { await observer.mergeGroups(into: target.id, from: from.id) }
                    }
                    mergeFrom = nil
                }
            }
            Button("Cancel", role: .cancel) { mergeFrom = nil }
        }
    }

    // MARK: - Derived

    private var flaggedAdherence: [MedAdherence] {
        observer.adherence.filter { $0.hasMisses }.sorted { $0.missed > $1.missed }
    }
    private var onTrackAdherence: [MedAdherence] {
        observer.adherence.filter { !$0.hasMisses }
    }
    private var missedTotal: Int { flaggedAdherence.reduce(0) { $0 + $1.missed } }
    private var mergeTargets: [MedGroup] {
        observer.groups.filter { $0.id != mergeFrom?.id }
    }
}

// MARK: - Take Last Group hero

private struct TakeLastGroupHero: View {
    @ObservedObject var observer: MedsObserver
    @State private var didTake = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let last = observer.lastGroup, let group = last.group {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(last.dueUnlogged ? "Due now" : "Next up")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(last.dueUnlogged ? .orange : .secondary)
                        Text(group.name).font(.headline)
                    }
                    Spacer()
                    if let time = group.scheduledTime {
                        Text(time).font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                if !group.activeMembers.isEmpty {
                    Text(group.activeMembers.map { "\($0.medName) \($0.effectiveDose)" }
                        .joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            } else {
                Text("No group due").font(.headline)
                Text("Create a group to enable one-tap logging.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Button {
                Task {
                    let ok = await observer.takeLastGroup()
                    if ok { withAnimation { didTake = true } }
                }
            } label: {
                HStack {
                    if observer.isMutating {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: didTake ? "checkmark.circle.fill" : "pills.fill")
                    }
                    Text(didTake ? "LOGGED" : "TAKE LAST GROUP")
                        .font(.subheadline.weight(.bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(didTake ? .green : .accentColor)
            .disabled(observer.isMutating || observer.lastGroup?.group == nil)
            .accessibilityIdentifier("meds-take-last-group")
        }
        .padding(.vertical, 4)
        .onChange(of: observer.lastGroup?.group?.id) { _, _ in didTake = false }
    }
}

// MARK: - Rows

private struct AdherenceRow: View {
    let adherence: MedAdherence
    let flagged: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(adherence.groupName).font(.subheadline.weight(.semibold))
                HStack(spacing: 6) {
                    OutlinePill(text: "\(adherence.taken) taken", tint: .green)
                    if adherence.skipped > 0 {
                        OutlinePill(text: "\(adherence.skipped) skipped", tint: .orange)
                    }
                    if adherence.missed > 0 {
                        OutlinePill(text: "\(adherence.missed) missed", tint: .red)
                    }
                }
            }
            Spacer()
            Text("\(Int(adherence.rate * 100))%")
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(flagged ? .red : .primary)
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("meds-adherence-\(adherence.groupId)")
    }
}

private struct GroupRow: View {
    let group: MedGroup

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.name).font(.body)
                Text("\(group.members.count) med\(group.members.count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let time = group.scheduledTime {
                Text(time).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("meds-group-row-\(group.id)")
    }
}

// MARK: - Shared state rows

struct LoadingRow: View {
    var body: some View {
        HStack { Spacer(); ProgressView(); Spacer() }
            .padding(.vertical, 24)
            .accessibilityIdentifier("meds-loading")
    }
}

struct ErrorRow: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't load", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Retry", action: retry).buttonStyle(.borderedProminent)
        }
        .accessibilityIdentifier("meds-error")
    }
}

// MARK: - Previews

#if DEBUG
@MainActor
private func sampleMedsObserver() -> MedsObserver {
    let o = MedsObserver()
    let morning = MedGroup(
        id: "g1", name: "Morning", scheduledTime: "08:00", sortOrder: 0,
        members: [
            MedGroupMember(id: "m1", groupId: "g1", medId: "med1", medName: "Vitamin D",
                           medDefault: "2000 IU", effectiveDose: "2000 IU"),
            MedGroupMember(id: "m2", groupId: "g1", medId: "med2", medName: "Omega-3",
                           medDefault: "1 g", effectiveDose: "1 g"),
        ])
    let bedtime = MedGroup(
        id: "g2", name: "Bedtime", scheduledTime: "22:00", sortOrder: 1,
        members: [
            MedGroupMember(id: "m3", groupId: "g2", medId: "med3", medName: "Magnesium",
                           medDefault: "400 mg", effectiveDose: "400 mg"),
        ])
    o.setForPreview(
        adherence: [
            MedAdherence(groupId: "g1", groupName: "Morning", scheduled: 7, taken: 5, skipped: 0, missed: 2),
            MedAdherence(groupId: "g2", groupName: "Bedtime", scheduled: 7, taken: 7, skipped: 0, missed: 0),
        ],
        groups: [morning, bedtime],
        lastGroup: MedLastGroup(found: true, group: morning, dueUnlogged: true),
        medications: [
            Medication(id: "med1", name: "Vitamin D", defaultDose: "2000", unit: "IU"),
            Medication(id: "med2", name: "Omega-3", defaultDose: "1", unit: "g"),
        ])
    return o
}

#Preview("Meds (sample)") {
    NavigationStack { MedicationGroupScene(observer: sampleMedsObserver()) }
}
#endif
