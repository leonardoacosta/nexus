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
    // dashboard-ui-pass-v1 (task 2.3): selection bridges the list pane to
    // SpecDetailView. Persisted in @State so tab/window resize doesn't drop
    // the active spec.
    @State private var selectedSpec: SpecSummary?

    var body: some View {
        HSplitView {
            leftPane
                .frame(minWidth: 280, idealWidth: 360)
            SpecDetailView(spec: selectedSpec)
                .frame(minWidth: 320, idealWidth: 520)
        }
        .task {
            await model.load()
            await model.subscribe()
        }
        .onDisappear {
            model.cancel()
        }
        // Keep selection in sync with the live spec list: if the selected
        // spec's row is refreshed (status/progress changed), pick up the
        // updated SpecSummary so the detail header reflects current state.
        .onChange(of: model.specs) { _, newSpecs in
            if let current = selectedSpec,
               let refreshed = newSpecs.first(where: { $0.id == current.id }) {
                selectedSpec = refreshed
            }
        }
    }

    private var leftPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.specs.isEmpty {
                ContentUnavailableView(
                    "No specs yet",
                    systemImage: "doc.text",
                    description: Text(
                        model.isLoading
                            ? "Loading…"
                            : "Waiting for the homelab spec-watcher to scan openspec/changes…"
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                listBody
            }
        }
        .padding(.vertical, 8)
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
                            SpecRow(
                                spec: spec,
                                isSelected: selectedSpec?.id == spec.id
                            )
                            .contentShape(Rectangle())
                            .onTapGesture {
                                selectedSpec = spec
                            }
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
    var isSelected: Bool = false

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
        .background(
            isSelected
                ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                : AnyShapeStyle(Color.clear)
        )
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
    /// Active /apply wave-plan projection from `GET /wave-plans/active`.
    /// Optional so the dashboard can distinguish three states:
    /// nil = fetch failed (hide chips), .isActive == false = no active
    /// run (hide chips), .isActive == true = render wave/status chips.
    /// Decoration only — never blocks the specs render path.
    @Published private(set) var wavePlan: WavePlanStatus?

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
        // Fetch specs + wave plan concurrently so the wave-plan call never
        // serializes behind the (larger) specs fetch. Wave plan is pure
        // decoration; even if it fails, specs still render.
        async let specsFetch = client.fetchSpecs()
        async let wavePlanFetch = client.fetchWavePlanStatus()
        self.specs = await specsFetch
        self.wavePlan = await wavePlanFetch
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
