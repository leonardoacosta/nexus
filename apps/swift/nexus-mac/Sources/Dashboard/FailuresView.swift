// FailuresView — macOS dashboard parity for apps/nextjs/src/app/failures.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.6)
//       openspec/changes/failures-investigation-and-surface (tasks 2.1-2.4)
// bd:nx-gaquu, nx-stwfu, nx-cv4kz, nx-dqkl4, nx-btn4p
//
// Aggregated tool-failure feed. Source: `NexusClient.fetchFailuresEnvelope()`
// (GET /failures?days=N), which returns the full aggregate envelope including
// `byTool`, `byProject`, and `trend` for the filter chips + trend indicator.
//
// UI augmentations from failures-investigation-and-surface:
// - Filter chip strip (tap to toggle membership in `activeToolFilters` /
//   `activeProjectFilters`; AND across categories, additive within)
// - Disambiguated empty-state ("No failures match this filter" vs
//   "No failures")
// - Trend indicator (↑Y% red / ↓Y% green; hidden when direction == "flat")

import SwiftUI
import NexusShared

struct FailuresView: View {
    @StateObject private var model = FailuresViewModel()
    @State private var expanded: Set<String> = []
    @State private var activeToolFilters: Set<String> = []
    @State private var activeProjectFilters: Set<String> = []

    /// Apply the filter chip selections to the model's errors. Empty
    /// selection in a category means "all" — only when at least one chip
    /// is selected does AND-filtering kick in for that category.
    private var filteredErrors: [ScriptError] {
        model.errors.filter { err in
            let toolMatch = activeToolFilters.isEmpty || activeToolFilters.contains(err.tool)
            // Notification-failures rows have no `project`; only filter the
            // tool-failure rows that carry one.
            let projectMatch = activeProjectFilters.isEmpty
                || (err.project.map { activeProjectFilters.contains($0) } ?? false)
            return toolMatch && projectMatch
        }
    }

    private var hasActiveFilters: Bool {
        !activeToolFilters.isEmpty || !activeProjectFilters.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !model.byTool.isEmpty || !model.byProject.isEmpty {
                filterChips
            }
            if filteredErrors.isEmpty {
                emptyState
            } else {
                listBody
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
            Text("FAILURES")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            trendIndicator
            Picker("", selection: $model.windowDays) {
                Text("1d").tag(1)
                Text("7d").tag(7)
                Text("30d").tag(30)
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
            .onChange(of: model.windowDays) { _, _ in
                Task { await model.load() }
            }
            Spacer()
            Text("\(model.errors.count)")
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

    /// Trend indicator. Hidden when direction == "flat" — no zero-percent
    /// visual noise per spec.
    @ViewBuilder
    private var trendIndicator: some View {
        if let label = FailuresView.trendLabel(for: model.trend) {
            Text(label.text)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(label.color)
        }
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.byTool.keys.sorted(), id: \.self) { tool in
                    chip(
                        label: "\(tool) (\(model.byTool[tool] ?? 0))",
                        selected: activeToolFilters.contains(tool)
                    ) {
                        toggle(&activeToolFilters, tool)
                    }
                }
                if !model.byTool.isEmpty && !model.byProject.isEmpty {
                    Divider().frame(height: 14)
                }
                ForEach(model.byProject.keys.sorted(), id: \.self) { project in
                    chip(
                        label: "\(project) (\(model.byProject[project] ?? 0))",
                        selected: activeProjectFilters.contains(project),
                        accent: .blue
                    ) {
                        toggle(&activeProjectFilters, project)
                    }
                }
                if hasActiveFilters {
                    Button {
                        activeToolFilters.removeAll()
                        activeProjectFilters.removeAll()
                    } label: {
                        Text("Clear filters")
                            .font(.caption2)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 14)
        }
    }

    @ViewBuilder
    private func chip(
        label: String,
        selected: Bool,
        accent: Color = .orange,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption2.monospacedDigit())
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(selected ? accent.opacity(0.25) : Color.secondary.opacity(0.10))
                .foregroundStyle(selected ? accent : Color.secondary)
                .cornerRadius(10)
        }
        .buttonStyle(.borderless)
    }

    @ViewBuilder
    private var emptyState: some View {
        if hasActiveFilters && model.total > 0 {
            VStack(spacing: 10) {
                ContentUnavailableView(
                    "No failures match this filter",
                    systemImage: "line.3.horizontal.decrease.circle",
                    description: Text("Loosen or clear the chip filters to see more rows.")
                )
                Button("Clear filters") {
                    activeToolFilters.removeAll()
                    activeProjectFilters.removeAll()
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView(
                "No failures",
                systemImage: "checkmark.seal",
                description: Text(
                    model.isLoading
                        ? "Loading…"
                        : "No script_errors in the last \(model.windowDays) day\(model.windowDays == 1 ? "" : "s")."
                )
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func toggle(_ set: inout Set<String>, _ value: String) {
        if set.contains(value) { set.remove(value) } else { set.insert(value) }
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(filteredErrors) { err in
                    FailureRow(
                        error: err,
                        isExpanded: expanded.contains(err.id),
                        onToggle: {
                            if expanded.contains(err.id) {
                                expanded.remove(err.id)
                            } else {
                                expanded.insert(err.id)
                            }
                        }
                    )
                    Divider().padding(.leading, 14)
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Pure logic helpers (exposed for testing)
    // ------------------------------------------------------------------

    struct TrendLabel: Equatable {
        let text: String
        let color: Color

        static func == (lhs: TrendLabel, rhs: TrendLabel) -> Bool {
            lhs.text == rhs.text
        }
    }

    /// Compute the visible trend label. Returns nil when direction=="flat"
    /// so the view hides the indicator entirely.
    ///
    /// Y = round(|current - previous| / max(previous, 1) * 100).
    static func trendLabel(for trend: FailureTrend) -> TrendLabel? {
        let delta = abs(trend.current - trend.previous)
        let denom = max(trend.previous, 1)
        let pct = Int((Double(delta) / Double(denom) * 100.0).rounded())
        switch trend.direction {
        case "up": return TrendLabel(text: "↑\(pct)%", color: .red)
        case "down": return TrendLabel(text: "↓\(pct)%", color: .green)
        default: return nil
        }
    }
}

private struct FailureRow: View {
    let error: ScriptError
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Image(systemName: "exclamationmark.octagon.fill")
                    .foregroundStyle(.red)
                    .padding(.top, 3)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(error.script)
                            .font(.system(.body, design: .monospaced))
                        if error.occurrences > 1 {
                            Text("×\(error.occurrences)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.orange)
                        }
                        if let project = error.project, !project.isEmpty {
                            Text(project)
                                .font(.caption2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.blue.opacity(0.15))
                                .foregroundStyle(.blue)
                                .cornerRadius(3)
                        }
                        Spacer()
                        Text(error.capturedAt, style: .relative)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Text(error.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(isExpanded ? nil : 2)
                    if let source = error.source {
                        Text(source)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                }
                if error.stack != nil {
                    Button(action: onToggle) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                    .padding(.top, 4)
                }
            }
            if isExpanded, let stack = error.stack {
                Text(stack)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.08))
                    .cornerRadius(4)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }
}

@MainActor
final class FailuresViewModel: ObservableObject {
    @Published var windowDays: Int = 7
    @Published private(set) var errors: [ScriptError] = []
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var byTool: [String: Int] = [:]
    @Published private(set) var byProject: [String: Int] = [:]
    @Published private(set) var trend: FailureTrend = FailureTrend()
    @Published private(set) var total: Int = 0
    @Published private(set) var source: String? = nil

    private let client = NexusShared.NexusAggregateClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        let envelope = await client.fetchFailuresEnvelope(days: windowDays)
        errors = envelope.topErrors.sorted { $0.capturedAt > $1.capturedAt }
        byTool = envelope.byTool
        byProject = envelope.byProject
        trend = envelope.trend
        total = envelope.total
        source = envelope.source
    }

    /// Testing seam: directly inject envelope data without hitting the
    /// network. Used by `FailuresViewTests`.
    func applyForTesting(_ envelope: FailuresResponse) {
        errors = envelope.topErrors
        byTool = envelope.byTool
        byProject = envelope.byProject
        trend = envelope.trend
        total = envelope.total
        source = envelope.source
    }
}
