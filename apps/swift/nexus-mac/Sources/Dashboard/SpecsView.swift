// SpecsView — macOS dashboard parity for apps/nextjs/src/app/specs.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.3)
//
// Read-only listing of every OpenSpec change across registered projects,
// grouped by project, with a live SpecTransition SSE subscription so
// status flips appear without a refresh.

import SwiftUI
import NexusShared

struct SpecsView: View {
    @StateObject private var model = SpecsViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.specs.isEmpty {
                ContentUnavailableView(
                    "No specs",
                    systemImage: "doc.text",
                    description: Text(model.isLoading ? "Loading…" : "No OpenSpec changes detected.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                listBody
            }
        }
        .padding(.vertical, 8)
        .task {
            await model.load()
            await model.subscribe()
        }
        .onDisappear {
            model.cancel()
        }
    }

    private var header: some View {
        HStack {
            Text("SPECS")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Spacer()
            if let latest = model.latestTransition {
                Text(latest)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tint)
            }
            Button {
                Task { await model.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh")
        }
        .padding(.horizontal, 14)
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6, pinnedViews: [.sectionHeaders]) {
                ForEach(model.grouped, id: \.project) { group in
                    Section {
                        ForEach(group.specs) { spec in
                            SpecRow(spec: spec)
                        }
                    } header: {
                        Text(group.project)
                            .font(.system(.caption, design: .monospaced))
                            .tracking(1.5)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.background.opacity(0.85))
                    }
                }
            }
        }
    }
}

private struct SpecRow: View {
    let spec: SpecSummary

    var body: some View {
        HStack(alignment: .top) {
            statusBadge
            VStack(alignment: .leading, spacing: 2) {
                Text(spec.name)
                    .font(.system(.body, design: .monospaced))
                HStack(spacing: 8) {
                    Text(spec.status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(spec.completedTasks)/\(spec.totalTasks)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    ProgressView(value: spec.progress)
                        .progressViewStyle(.linear)
                        .frame(width: 80)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }

    private var statusBadge: some View {
        let color: Color = {
            switch spec.status.lowercased() {
            case "approved":          return .blue
            case "in-progress":       return .orange
            case "draft":             return .gray
            case "archived", "done":  return .green
            case "rejected":          return .red
            default:                  return .secondary
            }
        }()
        return Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .padding(.top, 6)
    }
}

@MainActor
final class SpecsViewModel: ObservableObject {
    @Published private(set) var specs: [SpecSummary] = []
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var latestTransition: String?

    private let client = NexusShared.NexusAggregateClient()
    private var sseTask: Task<Void, Never>?

    struct Group: Equatable {
        let project: String
        let specs: [SpecSummary]
    }

    var grouped: [Group] {
        let buckets = Dictionary(grouping: specs, by: \.project)
        return buckets
            .map { Group(project: $0.key, specs: $0.value.sorted { $0.name < $1.name }) }
            .sorted { $0.project < $1.project }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        // Merged across reachable agents; partial failure tolerated.
        specs = await client.fetchSpecs()
    }

    func subscribe() async {
        sseTask?.cancel()
        sseTask = Task { [weak self] in
            guard let self else { return }
            // Aggregate owns per-agent retry; this returns on cancel only.
            await self.client.consumeSpecEvents { [weak self] event in
                await self?.handle(event: event)
            }
        }
    }

    func cancel() {
        sseTask?.cancel()
        sseTask = nil
    }

    private func handle(event: SSEEvent) async {
        guard event.name == "SpecTransition" else { return }
        latestTransition = "\(event.name)"
        // SpecTransition just signals "something moved" — refresh the
        // whole list rather than try to merge per-row. The list is small.
        await load()
    }
}
