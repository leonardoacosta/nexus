// MedicationGroupDetailScene (mx-ieau) — per-group member manager.
//
// Capability: src-meds (mx-t66o). Renders a group's members with the per-med
// actions in PRIORITY order (decision d):
//   1) tap a member          -> adjust dose (the most common action)
//   2) opt-out individual     -> swipe / context menu
//   3) change standing default-> context menu (long-press path, writes the
//                                medication's default dose, not just this group)
//
// Also: add a member (from the meds catalog), Take / Skip this group.

import SwiftUI
import NexusShared

struct MedicationGroupDetailScene: View {
    @ObservedObject var observer: MedsObserver
    let groupId: String

    @State private var showAddMember = false
    @State private var doseEdit: MedGroupMember?
    @State private var defaultEdit: MedGroupMember?

    private var group: MedGroup? { observer.groups.first { $0.id == groupId } }

    var body: some View {
        List {
            if let group {
                Section {
                    HStack(spacing: 12) {
                        Button {
                            Task { await observer.takeGroup(group.id) }
                        } label: {
                            Label("Take", systemImage: "pills.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        Button {
                            Task { await observer.skipGroup(group.id) }
                        } label: {
                            Label("Skip", systemImage: "forward.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered).tint(.orange)
                    }
                    .disabled(observer.isMutating)
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))

                Section("Members") {
                    if group.members.isEmpty {
                        ContentUnavailableView(
                            "No meds",
                            systemImage: "pills",
                            description: Text("Add a medication to this group."))
                    } else {
                        ForEach(group.members) { member in
                            MemberRow(member: member)
                                .contentShape(Rectangle())
                                .onTapGesture { doseEdit = member }   // tap = adjust dose
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await observer.removeMember(member.id) }
                                    } label: { Label("Remove", systemImage: "trash") }
                                    Button {
                                        Task {
                                            await observer.setMemberOptedOut(
                                                member.id, optedOut: !member.optedOut)
                                        }
                                    } label: {
                                        Label(member.optedOut ? "Opt in" : "Opt out",
                                              systemImage: member.optedOut ? "checkmark.circle" : "minus.circle")
                                    }.tint(.gray)
                                }
                                .contextMenu {
                                    Button { doseEdit = member } label: {
                                        Label("Adjust dose (this group)", systemImage: "slider.horizontal.3")
                                    }
                                    Button { defaultEdit = member } label: {
                                        Label("Change default dose", systemImage: "pencil")
                                    }
                                    Button {
                                        Task {
                                            await observer.setMemberOptedOut(
                                                member.id, optedOut: !member.optedOut)
                                        }
                                    } label: {
                                        Label(member.optedOut ? "Opt in" : "Opt out",
                                              systemImage: member.optedOut ? "checkmark.circle" : "minus.circle")
                                    }
                                }
                        }
                    }
                }
            } else {
                Section { ContentUnavailableView("Group not found", systemImage: "questionmark.folder") }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(group?.name ?? "Group")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("meds-group-detail")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showAddMember = true } label: { Image(systemName: "plus") }
                    .accessibilityIdentifier("meds-add-member")
            }
        }
        .sheet(isPresented: $showAddMember) {
            AddMemberSheet(observer: observer, groupId: groupId)
        }
        .sheet(item: $doseEdit) { member in
            DoseEditSheet(
                title: "Adjust dose · \(member.medName)",
                initial: member.effectiveDose
            ) { newDose in
                Task { await observer.setMemberDoseOverride(member.id, dose: newDose) }
            }
        }
        .sheet(item: $defaultEdit) { member in
            DoseEditSheet(
                title: "Default dose · \(member.medName)",
                initial: member.medDefault
            ) { newDose in
                Task { await observer.updateMedicationDefaultDose(member.medId, dose: newDose) }
            }
        }
    }
}

private struct MemberRow: View {
    let member: MedGroupMember

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(member.medName)
                    .font(.body)
                    .foregroundStyle(member.optedOut ? .secondary : .primary)
                HStack(spacing: 6) {
                    Text(member.effectiveDose).font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    if member.doseOverride != nil {
                        OutlinePill(text: "override", tint: .indigo)
                    }
                    if member.optedOut {
                        OutlinePill(text: "opted out", tint: .gray)
                    }
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("meds-member-\(member.id)")
    }
}

// MARK: - Dose edit sheet (shared by tap-adjust + change-default)

struct DoseEditSheet: View {
    let title: String
    let initial: String
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var dose: String

    init(title: String, initial: String, onSave: @escaping (String) -> Void) {
        self.title = title
        self.initial = initial
        self.onSave = onSave
        _dose = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Dose") {
                    TextField("e.g. 2000 IU", text: $dose)
                        .accessibilityIdentifier("meds-dose-field")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(dose.trimmingCharacters(in: .whitespaces))
                        dismiss()
                    }
                    .disabled(dose.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.height(220)])
    }
}

// MARK: - New group sheet

struct NewGroupSheet: View {
    @ObservedObject var observer: MedsObserver
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var hasTime = false
    @State private var time = Date()

    var body: some View {
        NavigationStack {
            Form {
                Section("Group") {
                    TextField("Name (e.g. Morning)", text: $name)
                        .accessibilityIdentifier("meds-group-name-field")
                }
                Section("Schedule") {
                    Toggle("Scheduled time", isOn: $hasTime)
                    if hasTime {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                }
            }
            .navigationTitle("New Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            await observer.createGroup(
                                name: name.trimmingCharacters(in: .whitespaces),
                                scheduledTime: hasTime ? Self.hhmm(time) : nil,
                                sortOrder: observer.groups.count)
                            dismiss()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private static func hhmm(_ date: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: date)
    }
}

// MARK: - Add-member sheet (pick from the meds catalog)

struct AddMemberSheet: View {
    @ObservedObject var observer: MedsObserver
    let groupId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if observer.medications.isEmpty {
                    ContentUnavailableView(
                        "No medications",
                        systemImage: "pills",
                        description: Text("Add a medication first."))
                } else {
                    ForEach(observer.medications) { med in
                        Button {
                            Task {
                                await observer.addMember(
                                    groupId: groupId, medId: med.id,
                                    doseOverride: nil, optedOut: false)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                Text(med.name)
                                Spacer()
                                Text("\(med.defaultDose) \(med.unit)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add Medication")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await observer.loadMedications() }
        }
    }
}

// MARK: - Add-med form (decision a)

struct AddMedicationSheet: View {
    @ObservedObject var observer: MedsObserver
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var dose = ""
    @State private var unit = "mg"
    @State private var rxnorm = ""

    private let units = ["mg", "mcg", "g", "IU", "mL", "tablet", "capsule", "drop"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Medication") {
                    TextField("Name", text: $name)
                        .accessibilityIdentifier("meds-med-name-field")
                }
                Section("Dose") {
                    TextField("Default dose (e.g. 2000)", text: $dose)
                        .keyboardType(.decimalPad)
                    Picker("Unit", selection: $unit) {
                        ForEach(units, id: \.self) { Text($0).tag($0) }
                    }
                }
                Section("Optional") {
                    TextField("RxNorm code", text: $rxnorm)
                        .keyboardType(.numberPad)
                }
            }
            .navigationTitle("Add Medication")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            _ = await observer.createMedication(
                                name: name.trimmingCharacters(in: .whitespaces),
                                defaultDose: dose.trimmingCharacters(in: .whitespaces),
                                unit: unit,
                                rxnorm: rxnorm.isEmpty ? nil : rxnorm)
                            dismiss()
                        }
                    }
                    .disabled(
                        name.trimmingCharacters(in: .whitespaces).isEmpty
                        || dose.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
