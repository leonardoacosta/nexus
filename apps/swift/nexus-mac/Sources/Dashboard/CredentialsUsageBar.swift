// CredentialsUsageBar — reusable per-row usage bar with reset countdown.
//
// Spec: credentials-account-resolve-and-usage (task 3.3)
//
// Renders a horizontal usage bar (green / yellow / red at 70% / 90%)
// plus a TimelineView-driven countdown label ("Resets in 2h 14m"). The
// component is intentionally state-free — callers feed the latest
// snapshot (used, limit, resetAt) every render.

import SwiftUI

/// Color thresholds for the 0-100% fill bar. Anything <70% is healthy
/// green, 70-90% is the yellow caution band, >=90% is red exhaustion.
private let WARN_THRESHOLD: Double = 0.7
private let CRITICAL_THRESHOLD: Double = 0.9

struct CredentialsUsageBar: View {
    let used: Int
    let limit: Int
    let resetAt: Date?
    let label: String

    /// Computed utilization ratio in 0...1. `limit == 0` is treated as 0%
    /// so the bar renders empty instead of dividing by zero.
    var utilization: Double {
        guard limit > 0 else { return 0 }
        let raw = Double(used) / Double(limit)
        return min(max(raw, 0), 1)
    }

    /// Color band the bar should fill with at the current utilization.
    var fillColor: Color {
        if utilization >= CRITICAL_THRESHOLD { return .red }
        if utilization >= WARN_THRESHOLD { return .yellow }
        return .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(used)/\(limit)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                if let resetAt {
                    Text(CredentialsUsageBar.formatCountdownStatic(to: resetAt, now: Date()))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.18))
                        .frame(height: 4)
                    Capsule()
                        .fill(fillColor)
                        .frame(
                            width: max(2, proxy.size.width * utilization),
                            height: 4
                        )
                }
            }
            .frame(height: 4)
        }
    }

    /// Compute the human-readable countdown text for `target` against
    /// `now`. Public-on-the-type so unit tests can drive the formatter
    /// without needing TimelineView.
    static func formatCountdown(to target: Date, now: Date = Date()) -> String {
        formatCountdownStatic(to: target, now: now)
    }

    fileprivate static func formatCountdownStatic(
        to target: Date,
        now: Date
    ) -> String {
        let delta = target.timeIntervalSince(now)
        if delta <= 0 { return "Reset due" }
        let totalSeconds = Int(delta)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        if hours >= 1 {
            return "Resets in \(hours)h \(minutes)m"
        }
        return "Resets in \(minutes)m"
    }
}
