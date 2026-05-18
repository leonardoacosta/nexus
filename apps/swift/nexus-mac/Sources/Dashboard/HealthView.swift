// HealthView — macOS dashboard parity for apps/nextjs/src/app/health.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.9)
// bd:nx-gaquu
//
// Three time-series charts per machine (CPU%, RAM%, Disk%) driven by
// `NexusClient.fetchHealthSeries(machine:since:)`. Uses the SwiftUI Charts
// framework (macOS 13+). The legacy `Sparkline` view on `nexus/nexus`
// remains for the menu-bar popover; this is the expanded dashboard pane.

import SwiftUI
import Charts
import NexusShared

struct HealthView: View {
    @StateObject private var model = HealthViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.points.isEmpty {
                ContentUnavailableView(
                    "No health samples",
                    systemImage: "waveform.path.ecg",
                    description: Text(
                        model.isLoading
                            ? "Loading…"
                            : "Agent reachable but health_snapshots is empty for the selected window."
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                charts
            }
        }
        .padding(.vertical, 8)
        .task {
            await model.load()
        }
        .refreshable {
            await model.load()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("HEALTH")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Picker("", selection: $model.windowMinutes) {
                Text("10m").tag(10)
                Text("1h").tag(60)
                Text("6h").tag(360)
                Text("24h").tag(1440)
            }
            .pickerStyle(.segmented)
            .frame(width: 240)
            .onChange(of: model.windowMinutes) { _, _ in
                Task { await model.load() }
            }
            Spacer()
            Text("\(model.points.count) pts")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            Button {
                Task { await model.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh")
            .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 14)
    }

    private var charts: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HealthChart(
                    title: "CPU",
                    color: .red,
                    points: model.points,
                    value: { $0.cpuPercent }
                )
                HealthChart(
                    title: "RAM",
                    color: .blue,
                    points: model.points,
                    value: { $0.ramPercent }
                )
                HealthChart(
                    title: "DISK",
                    color: .orange,
                    points: model.points,
                    value: { $0.diskPercent }
                )
            }
            .padding(.horizontal, 14)
        }
    }
}

private struct HealthChart: View {
    let title: String
    let color: Color
    let points: [HealthSnapshot]
    let value: (HealthSnapshot) -> Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .font(.system(.caption, design: .monospaced))
                    .tracking(1.5)
                    .foregroundStyle(.secondary)
                Spacer()
                if let latest = points.last, let v = value(latest) {
                    Text(String(format: "%.1f%%", v))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(color)
                }
            }
            Chart {
                ForEach(points.indices, id: \.self) { idx in
                    let p = points[idx]
                    if let v = value(p) {
                        LineMark(
                            x: .value("t", p.timestamp),
                            y: .value(title, v)
                        )
                        .foregroundStyle(color)
                        .interpolationMethod(.monotone)
                        AreaMark(
                            x: .value("t", p.timestamp),
                            y: .value(title, v)
                        )
                        .foregroundStyle(color.opacity(0.12))
                        .interpolationMethod(.monotone)
                    }
                }
            }
            .chartYScale(domain: 0...100)
            .chartYAxis {
                AxisMarks(values: [0, 50, 100]) { value in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                    AxisValueLabel {
                        if let n = value.as(Double.self) {
                            Text("\(Int(n))").font(.caption2)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                    AxisValueLabel(format: .dateTime.hour().minute())
                }
            }
            .frame(height: 120)
        }
    }
}

@MainActor
final class HealthViewModel: ObservableObject {
    @Published var windowMinutes: Int = 60
    @Published private(set) var points: [HealthSnapshot] = []
    @Published private(set) var isLoading: Bool = false

    private let client = NexusShared.NexusAggregateClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        let since = Date().addingTimeInterval(-Double(windowMinutes) * 60)
        // Merged + sorted across all reachable agents; partial failure OK.
        let rows = await client.fetchHealthSeries(since: since)
        points = rows.sorted { $0.timestamp < $1.timestamp }
    }
}
