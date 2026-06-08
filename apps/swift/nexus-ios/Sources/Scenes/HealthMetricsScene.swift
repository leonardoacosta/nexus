// HealthMetricsScene (mx-rtfe) — HEALTH_METRIC surface (HealthKit-derived).
// Standalone (not in the work-triage aggregate). Renders HealthBody over Core.
// READ-ONLY.
//
// NOTE on naming: nx already uses "Health" for SYSTEM metrics (CPU/mem/disk —
// HealthSummaryScene). This biometric surface is named HealthMetricsScene to
// avoid the collision (per the swift skill naming watch-out).
//
// Design: ~/dev/mx/docs/nx-ui/nx-wireframe-health.html (iOS compact).
// "Attention" section lists anomaly_reason != null metrics first (red), then
// metric cards: humanized type, value+unit (mono), min/avg/max sparkline via
// Swift Charts, sourceDevice badge. Tap -> DetailScene.

import SwiftUI
import Charts
import NexusShared

struct HealthMetricsScene: View {
    @ObservedObject var observer: TriageObserver

    var body: some View {
        List {
            if observer.isSampleData {
                Section { SampleCaptionRow(id: "health-sample-caption") }
            }
            if !flagged.isEmpty {
                Section {
                    ForEach(flagged) { item in
                        NavigationLink(value: item) { AttentionCard(item: item) }
                    }
                } header: {
                    Label("Attention · \(flagged.count) needing review", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
            Section("Today's Metrics") {
                if observer.health.isEmpty {
                    ContentUnavailableView("No metrics", systemImage: "heart")
                } else {
                    ForEach(observer.health) { item in
                        NavigationLink(value: item) { MetricCard(item: item) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Health Metrics")
        .navigationDestination(for: TriageItem.self) { DetailScene(item: $0) }
        .accessibilityIdentifier("health-metrics-scene")
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
    }

    private var flagged: [TriageItem] {
        observer.health.filter { $0.payload.health?.isAnomalous == true }
    }
}

private func humanize(_ metricType: String) -> String {
    metricType.split(separator: "_")
        .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        .joined(separator: " ")
}

private struct AttentionCard: View {
    let item: TriageItem
    private var b: HealthBody? { item.payload.health }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title).font(.subheadline.weight(.semibold))
            if let reason = b?.anomalyReason {
                Text(reason).font(.caption).foregroundStyle(.red)
            }
            HStack {
                if let dev = b?.sourceDevice {
                    Label(dev, systemImage: "applewatch").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let b {
                    Text("\(FinanceFormat.trim(b.value)) \(b.unit)")
                        .font(.body.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.red)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("health-attention-\(item.id)")
    }
}

private struct MetricCard: View {
    let item: TriageItem
    private var b: HealthBody? { item.payload.health }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(humanize(b?.metricType ?? item.title))
                        .font(.subheadline.weight(.semibold))
                    if let dev = b?.sourceDevice {
                        Text(dev).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if let b {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(FinanceFormat.trim(b.value))
                            .font(.title3.monospacedDigit().weight(.semibold))
                        Text(b.unit).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let b, let mn = b.min, let avg = b.avg, let mx = b.max {
                Sparkline(min: mn, avg: avg, max: mx, value: b.value, flagged: b.isAnomalous)
                    .frame(height: 26)
                Text("min \(FinanceFormat.trim(mn)) · avg \(FinanceFormat.trim(avg)) · max \(FinanceFormat.trim(mx))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityIdentifier("health-metric-\(item.id)")
    }
}

/// Tiny min->avg->value->max range chart (a stand-in for a real time series
/// until the live feed provides samples).
private struct Sparkline: View {
    let min: Double, avg: Double, max: Double, value: Double
    let flagged: Bool

    var body: some View {
        Chart {
            ForEach(points, id: \.0) { label, v in
                LineMark(x: .value("p", label), y: .value("v", v))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(flagged ? Color.red : Color.blue)
                PointMark(x: .value("p", label), y: .value("v", v))
                    .foregroundStyle(flagged ? Color.red : Color.blue)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
    }

    private var points: [(String, Double)] {
        [("min", min), ("avg", avg), ("now", value), ("max", max)]
    }
}

#if DEBUG
#Preview("Health Metrics (sample)") {
    NavigationStack {
        HealthMetricsScene(observer: {
            let o = TriageObserver(); o.setItemsForPreview(TriageItem.sampleData, isSample: true); return o
        }())
    }
}
#endif
