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
    // specs-tab-accordion-with-topology (task 2.4): per-project accordion
    // state, default collapsed. Hydrated from UserDefaults
    // `specsAccordion.<slug>` on the first render of each group, persisted
    // on every toggle.
    @State private var expandedProjects: Set<String> = []
    // specs-tab-accordion-with-topology (task 2.5): shared with AppNavigation
    // / SessionsView so the project header can count active sessions whose
    // cwd resolves to that project's slug. Optional so the view still
    // builds in isolation (previews, tests).
    @ObservedObject var sessionObserver: SessionObserver

    init(sessionObserver: SessionObserver) {
        self.sessionObserver = sessionObserver
    }

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
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(model.grouped, id: \.project) { group in
                    DisclosureGroup(
                        isExpanded: binding(for: group.project)
                    ) {
                        ForEach(group.specs) { spec in
                            SpecRow(
                                spec: spec,
                                isSelected: selectedSpec?.id == spec.id,
                                waveStatus: model.wavePlan?.lookupSpec(name: spec.name)
                            )
                            .contentShape(Rectangle())
                            .onTapGesture {
                                selectedSpec = spec
                            }
                        }
                    } label: {
                        projectHeader(for: group)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
                }
            }
        }
    }

    /// Project group header — slug, completion summary, and an
    /// active-session pulsing green dot when at least one CC session
    /// is running inside that project's working directory. The dot is
    /// `.help`-decorated so hovering surfaces the active-session count.
    ///
    /// specs-tab-accordion-with-topology tasks 2.5 (session dot) + 2.6
    /// (wave rollup chip) compose here so a single header header renders
    /// every adornment with the same layout budget.
    @ViewBuilder
    private func projectHeader(for group: SpecsViewModel.Group) -> some View {
        let totalSpecs = group.specs.count
        let activeSpecs = group.specs.filter {
            switch $0.status.lowercased() {
            case "in-progress", "approved": return true
            default: return false
            }
        }.count
        let sessionCount = activeSessionCount(forProject: group.project)
        HStack(spacing: 8) {
            Text(group.project)
                .font(.system(.caption, design: .monospaced))
                .tracking(1.5)
                .foregroundStyle(.secondary)
            Text("\(activeSpecs)/\(totalSpecs) active")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            if sessionCount > 0 {
                ActiveSessionDot(count: sessionCount)
            }
            if let chip = waveRollupChip(forProject: group.project) {
                chip
            }
            Spacer(minLength: 0)
        }
    }

    /// Count active CC sessions whose `cwd` resolves to the given project
    /// slug. Two boundary checks guard against substring collisions
    /// (`nx` matching `nexus`): the slug must be the LAST path segment
    /// or appear as `/dev/<slug>/`. Reads from the shared
    /// `SessionObserver.sessions` published list — staying inside the
    /// macOS dashboard's existing data flow rather than spinning up a
    /// separate fetch.
    private func activeSessionCount(forProject project: String) -> Int {
        let suffix = "/dev/\(project)"
        let middle = "/dev/\(project)/"
        return sessionObserver.activeSessions.filter { session in
            guard let cwd = session.cwd, !cwd.isEmpty else { return false }
            return cwd.contains(middle) || cwd.hasSuffix(suffix)
        }.count
    }

    /// Wave rollup chip for the project header (task 2.6). Hidden when
    /// no /apply is active, or when none of this project's specs are
    /// in the wave plan. Renders `[W{n}]` for a single-wave plan and
    /// `[W{min}-W{max}]` for multi-wave plans, followed by a count of
    /// dispatched/in_progress specs scoped to this project.
    @ViewBuilder
    private func waveRollupChip(forProject project: String) -> AnyView? {
        guard let plan = model.wavePlan, plan.isActive else { return nil }
        // Names of specs that belong to this project in the live spec list.
        let names = Set(
            model.grouped
                .first(where: { $0.project == project })?
                .specs
                .map(\.name) ?? []
        )
        let matching = plan.specStatuses.filter { names.contains($0.name) }
        guard !matching.isEmpty else { return nil }
        let waves = matching.map(\.wave)
        let minW = waves.min() ?? 0
        let maxW = waves.max() ?? 0
        let label = minW == maxW ? "[W\(minW)]" : "[W\(minW)-W\(maxW)]"
        let inflight = matching.filter {
            $0.status == .dispatched || $0.status == .in_progress
        }.count
        return AnyView(
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tint)
                if inflight > 0 {
                    Text("· \(inflight) dispatched")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tint.opacity(0.7))
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.tint.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 4))
        )
    }

    /// Two-way binding for a project's accordion expansion. Reads
    /// initial state from UserDefaults (default: collapsed) and
    /// persists on every toggle so the user's last layout sticks
    /// across window restarts. The local `Set<String>` mirror keeps
    /// SwiftUI's diff cheap — only the toggled row redraws.
    ///
    /// UserDefaults key: `specsAccordion.<slug>` (per
    /// specs-tab-accordion-with-topology task 2.4).
    private func binding(for project: String) -> Binding<Bool> {
        Binding(
            get: {
                if expandedProjects.contains(project) { return true }
                // Lazy hydrate from UserDefaults the first time this
                // project's binding is asked for. `bool(forKey:)` returns
                // false for absent keys — which is the documented default.
                return UserDefaults.standard.bool(forKey: "specsAccordion.\(project)")
            },
            set: { newValue in
                if newValue {
                    expandedProjects.insert(project)
                } else {
                    expandedProjects.remove(project)
                }
                UserDefaults.standard.set(newValue, forKey: "specsAccordion.\(project)")
            }
        )
    }
}

private struct SpecRow: View {
    let spec: SpecSummary
    var isSelected: Bool = false
    /// Active wave-plan row for this spec, when present. Drives the
    /// [W{n}] chip + status dot adornments (task 2.7). Nil when the
    /// spec is not in the in-flight wave plan or no /apply is active.
    var waveStatus: SpecStatus?

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
                    if let wave = waveStatus {
                        WaveChip(wave: wave.wave)
                        WaveStatusDot(status: wave.status)
                    }
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

/// Pulsing green dot rendered on a project header when at least one
/// CC session is running inside that project's working directory.
/// Hover-tooltip surfaces the exact session count.
///
/// specs-tab-accordion-with-topology task 2.5.
private struct ActiveSessionDot: View {
    let count: Int
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(Color.green)
            .frame(width: 7, height: 7)
            .opacity(pulsing ? 0.4 : 1.0)
            .animation(
                .easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                value: pulsing
            )
            .onAppear { pulsing = true }
            .help("\(count) active session\(count == 1 ? "" : "s")")
    }
}

/// `[W{n}]` chip rendered next to the progress bar of a spec that's in
/// the active wave plan. Monospaced so the chip width stays steady as
/// wave numbers grow.
///
/// specs-tab-accordion-with-topology task 2.7.
private struct WaveChip: View {
    let wave: Int

    var body: some View {
        Text("[W\(wave)]")
            .font(.caption2.monospaced())
            .foregroundStyle(.tint)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(.tint.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

/// Status dot for a wave-plan spec row. Color encodes the canonical
/// SpecRunStatus enum; `in_progress` is the only state that pulses
/// (every other state is steady so the row doesn't hum visually).
///
/// specs-tab-accordion-with-topology task 2.7.
private struct WaveStatusDot: View {
    let status: SpecRunStatus
    @State private var pulsing = false

    private var color: Color {
        switch status {
        case .queued:      return .gray
        case .dispatched:  return .blue
        case .in_progress: return .blue
        case .completed:   return .green
        case .failed:      return .red
        case .skipped:     return .yellow
        }
    }

    var body: some View {
        let isInflight = status == .in_progress
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .opacity(isInflight && pulsing ? 0.4 : 1.0)
            .animation(
                isInflight
                    ? .easeInOut(duration: 1.0).repeatForever(autoreverses: true)
                    : .default,
                value: pulsing
            )
            .onAppear { if isInflight { pulsing = true } }
            .help("wave status: \(status.rawValue)")
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
