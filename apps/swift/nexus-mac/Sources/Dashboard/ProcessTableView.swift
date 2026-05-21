// ProcessTableView — two-column top-CPU / top-RAM process table.
//
// Spec: openspec/changes/health-tab-process-view (requirement
// `health-process-table-view`).
//
// Sits BELOW the time-series charts in HealthView. Each column is its own
// ScrollView so the user can scan deep into either list without affecting
// the other. The component is intentionally state-free — its inputs are
// the latest `HealthProcessesResponse` snapshot plus a staleness flag the
// parent computes via TimelineView. When `processes == nil` OR both top
// lists are empty the section hides entirely (warming-up case).

import SwiftUI
import NexusShared

/// Caption for numeric uids; Linux returns plain digit strings, macOS the
/// username. Prefix only when EVERY rune is a digit so we don't mangle a
/// real account named "1024".
internal let NUMERIC_UID_REGEX = try? NSRegularExpression(pattern: "^[0-9]+$")

/// Format a process owner string for display. Numeric uids (Linux) get a
/// `uid:` prefix; usernames (macOS) pass through. Internal so the test
/// probe (and HealthView) can share the same implementation.
internal func renderProcessUser(_ user: String?) -> String? {
    guard let user, !user.isEmpty else { return nil }
    let range = NSRange(user.startIndex..<user.endIndex, in: user)
    if let regex = NUMERIC_UID_REGEX, regex.firstMatch(in: user, range: range) != nil {
        return "uid:\(user)"
    }
    return user
}

/// Compute the staleness flag + human-readable age label for a snapshot.
/// Shared between HealthView (which wraps it in a TimelineView) and the
/// unit tests. The 30s threshold matches the spec's "snapshot stale"
/// scenario.
internal func processSnapshotStaleness(
    collectedAt: Date?,
    now: Date,
    threshold: TimeInterval = 30
) -> (isStale: Bool, label: String?) {
    guard let collectedAt else { return (false, nil) }
    let age = now.timeIntervalSince(collectedAt)
    guard age > threshold else { return (false, nil) }
    return (true, formatProcessAge(seconds: age))
}

internal func formatProcessAge(seconds: TimeInterval) -> String {
    if seconds < 60 { return "\(Int(seconds))s" }
    let minutes = Int(seconds / 60)
    let remainder = Int(seconds) % 60
    if remainder == 0 { return "\(minutes)m" }
    return "\(minutes)m \(remainder)s"
}

/// Test-only probe surface so `ProcessTableViewTests` can exercise the
/// helpers without re-implementing them.
internal enum ProcessTableTestProbe {
    static func renderUser(_ user: String?) -> String? {
        renderProcessUser(user)
    }
    static func staleness(
        collectedAt: Date?,
        now: Date,
        threshold: TimeInterval = 30
    ) -> (isStale: Bool, label: String?) {
        processSnapshotStaleness(
            collectedAt: collectedAt,
            now: now,
            threshold: threshold
        )
    }
}

struct ProcessTableView: View {
    let processes: HealthProcessesResponse
    /// Caller-computed staleness flag (collectedAt > 30s old).
    var isStale: Bool = false
    /// Caller-computed staleness age string ("Xs"). Only consulted when
    /// `isStale` is true.
    var staleAgeLabel: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if isStale, let staleAgeLabel {
                Text("snapshot stale — collector last ticked \(staleAgeLabel) ago")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
            }
            HStack(alignment: .top, spacing: 16) {
                column(
                    title: "TOP CPU",
                    accent: .blue,
                    metric: \HealthMetrics.ProcessInfo.cpuPercent,
                    rows: processes.topCpu
                )
                column(
                    title: "TOP RAM",
                    accent: .orange,
                    metric: \HealthMetrics.ProcessInfo.ramPercent,
                    rows: processes.topRam
                )
            }
            .padding(.horizontal, 14)
        }
        .opacity(isStale ? 0.5 : 1)
    }

    @ViewBuilder
    private func column(
        title: String,
        accent: Color,
        metric: KeyPath<HealthMetrics.ProcessInfo, Double>,
        rows: [HealthMetrics.ProcessInfo]
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(.caption, design: .monospaced))
                .tracking(1.5)
                .foregroundStyle(.secondary)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(rows, id: \.pid) { row in
                        ProcessRow(row: row, accent: accent, metric: metric)
                    }
                }
            }
            .frame(maxHeight: 280)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ProcessRow: View {
    let row: HealthMetrics.ProcessInfo
    let accent: Color
    let metric: KeyPath<HealthMetrics.ProcessInfo, Double>

    private var value: Double { row[keyPath: metric] }
    private var clamped: Double { min(max(value / 100.0, 0), 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text("\(row.pid)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .frame(width: 56, alignment: .leading)
                Text(row.name)
                    .font(.callout.bold())
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(String(format: "%.1f%%", value))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(accent)
            }
            if let userLabel = renderProcessUser(row.user) {
                Text(userLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let command = row.command, !command.isEmpty {
                Text(command)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            ProgressView(value: clamped)
                .progressViewStyle(.linear)
                .tint(accent)
        }
        .padding(.vertical, 2)
    }
}
