// MedicationHistoryScene (mx-jc0k) — the per-dose logbook (History feed).
//
// Capability: src-meds (mx-t66o). Reverse-chronological per-dose feed from
// `GET /meds/history`, paginated via `before=<oldest loggedAt>`. Each row:
// med name, group, status (taken / skipped / missed), time, dose. The
// adherence/misses triage is the MAIN view (MedicationGroupScene); this is the
// secondary logbook reachable from the Meds tab menu.

import SwiftUI
import NexusShared

struct MedicationHistoryScene: View {
    @ObservedObject var observer: MedsObserver
    @State private var didInitialLoad = false

    var body: some View {
        List {
            if observer.history.isEmpty && didInitialLoad {
                Section {
                    ContentUnavailableView(
                        "No doses yet",
                        systemImage: "list.bullet.rectangle",
                        description: Text("Logged doses appear here, newest first."))
                }
            } else {
                ForEach(grouped, id: \.key) { bucket in
                    Section(bucket.key) {
                        ForEach(bucket.doses) { dose in DoseRow(dose: dose) }
                    }
                }
                if !observer.history.isEmpty {
                    Section {
                        Button("Load older") {
                            Task { await observer.loadHistory(before: observer.history.last?.loggedAt) }
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("meds-history-load-older")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("meds-history-scene")
        .task {
            if !didInitialLoad {
                await observer.loadHistory()
                didInitialLoad = true
            }
        }
        .refreshable { await observer.loadHistory() }
    }

    private var grouped: [(key: String, doses: [MedDose])] {
        let fmt = DateFormatter(); fmt.dateFormat = "EEE, MMM d"
        let cal = Calendar.current
        let buckets = Dictionary(grouping: observer.history) { dose -> String in
            guard let d = dose.loggedAt else { return "Earlier" }
            if cal.isDateInToday(d) { return "Today" }
            if cal.isDateInYesterday(d) { return "Yesterday" }
            return fmt.string(from: d)
        }
        let order = ["Today", "Yesterday"]
        return buckets.sorted { a, b in
            let ai = order.firstIndex(of: a.key) ?? Int.max
            let bi = order.firstIndex(of: b.key) ?? Int.max
            if ai != bi { return ai < bi }
            return a.key > b.key
        }.map { ($0.key, $0.value.sorted { ($0.loggedAt ?? .distantPast) > ($1.loggedAt ?? .distantPast) }) }
    }
}

private struct DoseRow: View {
    let dose: MedDose

    var body: some View {
        HStack(spacing: 10) {
            statusIcon
            VStack(alignment: .leading, spacing: 3) {
                Text(dose.medName ?? "Medication").font(.body).lineLimit(1)
                HStack(spacing: 6) {
                    if let g = dose.groupName { OutlinePill(text: g) }
                    if !dose.dose.isEmpty {
                        Text(dose.dose).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 4)
            if let t = dose.loggedAt {
                Text(t, format: .dateTime.hour().minute())
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("meds-dose-\(dose.id)")
    }

    @ViewBuilder private var statusIcon: some View {
        if dose.isSkipped {
            Image(systemName: "forward.circle.fill").foregroundStyle(.orange)
        } else if dose.isMissed {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
        } else {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        }
    }
}

#if DEBUG
#Preview("Meds History (sample)") {
    let o = MedsObserver()
    o.setForPreview(history: [
        MedDose(id: "d1", medId: "med1", medName: "Vitamin D", groupName: "Morning",
                loggedAt: Date(), status: "taken", dose: "2000 IU"),
        MedDose(id: "d2", medId: "med3", medName: "Magnesium", groupName: "Bedtime",
                loggedAt: Date().addingTimeInterval(-3600), status: "skipped", dose: "400 mg"),
        MedDose(id: "d3", medId: "med2", medName: "Omega-3", groupName: "Morning",
                loggedAt: Date().addingTimeInterval(-90_000), status: "missed", dose: "1 g"),
    ])
    return NavigationStack { MedicationHistoryScene(observer: o) }
}
#endif
