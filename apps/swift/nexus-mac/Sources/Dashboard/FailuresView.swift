// FailuresView — macOS dashboard parity for apps/nextjs/src/app/failures.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.6)
// bd:nx-gaquu
//
// Aggregated tool-failure feed. Source: `NexusClient.fetchScriptErrors()`
// (GET /failures?days=N), which returns the agent's top_errors array
// fingerprinted by stack trace. Each row is expandable to show the full
// stack inline.

import SwiftUI
import NexusShared

struct FailuresView: View {
    @StateObject private var model = FailuresViewModel()
    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.errors.isEmpty {
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

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(model.errors) { err in
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

    private let client = NexusShared.NexusAggregateClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        // Merged + sorted across all reachable agents; partial failure OK.
        errors = await client.fetchScriptErrors(limit: 100, days: windowDays)
    }
}
