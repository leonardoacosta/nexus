// CredentialsUsageHistoryChart — per-account utilization sparkline.
//
// Spec: openspec/changes/credential-usage-history (task 3.3) — bd:nx-9hamt
//
// State-free Swift Charts LineMark over an account's usage-history series:
// x = polledAt, y = utilization ratio (used/limit, 0...1). Callers feed the
// latest `[UsageHistoryPoint]` every render. When there are no points the
// chart renders nothing (EmptyView) so the row collapses cleanly rather than
// showing an empty axis frame — the endpoint 404s / returns [] until the
// homelab poller has accumulated history.
//
// Mirrors the state-free shape of `CredentialsUsageBar`: computed properties
// (utilization ratios, `hasData`) are exposed on the type so unit tests can
// drive the mapping without instantiating the Chart view.

import SwiftUI
import Charts
import NexusShared

struct CredentialsUsageHistoryChart: View {
    let points: [NexusShared.UsageHistoryPoint]
    /// Window label ("5h" / "7d") rendered as a caption beside the sparkline.
    let label: String

    /// True when there is at least one point to plot. The body renders nothing
    /// when this is false — the row hides the whole section.
    var hasData: Bool { !points.isEmpty }

    /// (polledAt, utilization) pairs the LineMark plots. Utilization comes
    /// straight off `UsageHistoryPoint.utilization` (0...1, zero-limit safe).
    /// Exposed for the unit test's points → ratio assertion.
    var ratios: [(date: Date, ratio: Double)] {
        points.map { ($0.polledAt, $0.utilization) }
    }

    var body: some View {
        if hasData {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(label) trend")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                Chart {
                    ForEach(points) { point in
                        LineMark(
                            x: .value("t", point.polledAt),
                            y: .value("util", point.utilization)
                        )
                        .foregroundStyle(.secondary)
                        .interpolationMethod(.monotone)
                        AreaMark(
                            x: .value("t", point.polledAt),
                            y: .value("util", point.utilization)
                        )
                        .foregroundStyle(.secondary.opacity(0.12))
                        .interpolationMethod(.monotone)
                    }
                }
                .chartYScale(domain: 0...1)
                .chartYAxis {
                    AxisMarks(values: [0, 0.5, 1]) { value in
                        AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                        AxisValueLabel {
                            if let n = value.as(Double.self) {
                                Text("\(Int(n * 100))%").font(.caption2)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                        AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                        AxisValueLabel(format: .dateTime.hour().minute())
                    }
                }
                .frame(height: 44)
                .accessibilityIdentifier("credentials-usage-history-chart")
            }
        }
    }
}

#if DEBUG
#Preview("Usage history sparkline") {
    let now = Date()
    let mock: [NexusShared.UsageHistoryPoint] = (0..<12).map { i in
        NexusShared.UsageHistoryPoint(
            polledAt: now.addingTimeInterval(Double(i) * 300),
            used: 100 + i * 40,
            limit: 800
        )
    }
    return VStack(alignment: .leading, spacing: 12) {
        CredentialsUsageHistoryChart(points: mock, label: "5h")
        CredentialsUsageHistoryChart(points: [], label: "7d")  // renders nothing
    }
    .padding()
    .frame(width: 320)
}
#endif
