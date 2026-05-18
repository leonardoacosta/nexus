// HealthSummaryScene — compact health overview reused on the Health tab.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.3)
//
// Read-only mirror of the macOS Health pane. Full parity (sparklines,
// per-machine drilldown) ships via swift-dashboard-feature-parity.

import SwiftUI
import NexusShared

struct HealthSummaryScene: View {
    @EnvironmentObject private var observer: SessionObserver

    var body: some View {
        List {
            Section("Connection") {
                LabeledContent("State", value: observer.aggregateState.rawValue)
                LabeledContent(
                    "Last heartbeat",
                    value: observer.lastHeartbeat.map { Self.format($0) } ?? "—"
                )
            }
            Section("Metrics") {
                if observer.metrics.isEmpty {
                    Text("No samples yet.").foregroundStyle(.secondary)
                } else {
                    ForEach(Array(observer.metrics.suffix(10).enumerated()), id: \.offset) { _, snapshot in
                        VStack(alignment: .leading) {
                            Text(Self.format(snapshot.timestamp))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack {
                                if let cpu = snapshot.cpuPercent {
                                    Label(String(format: "CPU %.0f%%", cpu),
                                          systemImage: "cpu")
                                }
                                if let ram = snapshot.ramPercent {
                                    Label(String(format: "RAM %.0f%%", ram),
                                          systemImage: "memorychip")
                                }
                            }
                            .font(.caption)
                        }
                    }
                }
            }
        }
    }

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .medium
        return f
    }()

    private static func format(_ date: Date) -> String {
        formatter.string(from: date)
    }
}
