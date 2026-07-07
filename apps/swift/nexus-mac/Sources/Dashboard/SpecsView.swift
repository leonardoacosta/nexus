// SpecsView — macOS dashboard parity for apps/nextjs/src/app/specs.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.3)
//
// Read-only listing of every OpenSpec change across registered projects,
// grouped by project, with a live SpecTransition SSE subscription so
// status flips appear without a refresh.

import SwiftUI
import NexusShared

/// Right-pane state for SpecsView. The detail vs PTY swap is modelled as a
/// discriminated enum so the view body never renders both at once and the
/// transitions are auditable (specs-tab-start-on-spec § Swift UI § SpecsView
/// changes). `.empty` is the initial state — neither a spec nor a PTY is
/// shown — and exists primarily for the test harness so we can assert the
/// "no selection" branch in unit tests.
enum SpecsRightPaneState: Equatable {
    case empty
    case spec(SpecSummary)
    case pty(sessionId: String, fromSpec: SpecSummary)
}

/// Optimistic placeholder sessionId surfaced to the PTY header while the
/// `POST /session/start` call is in flight. Replaced with the real
/// `session_id` on success or reverted to `.spec(fromSpec)` on failure.
/// Tests assert on this constant.
let SpecsViewStartingSessionPlaceholder = "starting..."

struct SpecsView: View {
    @StateObject private var model = SpecsViewModel()
    // dashboard-ui-pass-v1 (task 2.3): selection bridges the list pane to
    // SpecDetailView. Persisted in @State so tab/window resize doesn't drop
    // the active spec.
    @State private var selectedSpec: SpecSummary?
    // specs-tab-start-on-spec (task 3.5): right-pane state machine. The
    // body switches on this; `.spec` renders SpecDetailView, `.pty`
    // renders the existing PtyViewer from the Sessions tab. Stays in
    // sync with `selectedSpec` via .onChange so tapping a row defaults
    // to `.spec(row)`.
    @State private var rightPane: SpecsRightPaneState = .empty
    // Latest "Start Session" error banner shown above the row list. Cleared
    // when the user selects any other spec or starts a new session.
    @State private var startError: String?
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
            rightPaneBody
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
                // When the selected spec gets refreshed AND we're showing
                // its detail pane, mirror the refresh into the rightPane
                // so SpecDetailView's frontmatter / status updates without
                // a fetch ping-pong.
                if case .spec = rightPane {
                    rightPane = .spec(refreshed)
                }
            }
        }
        .onChange(of: selectedSpec) { _, newSelection in
            // Clear the error banner whenever the user picks a different
            // row. Then mirror the selection into the right pane unless
            // we're already on a PTY for the same spec.
            startError = nil
            guard let s = newSelection else {
                rightPane = .empty
                return
            }
            if case let .pty(_, fromSpec) = rightPane, fromSpec.id == s.id {
                // Keep the PTY visible — user just re-tapped the same row.
                return
            }
            rightPane = .spec(s)
        }
    }

    /// Right pane: detail vs PTY vs hint. Centralises the rendering branch
    /// so unit tests can assert on `rightPane` alone without poking at the
    /// view hierarchy.
    @ViewBuilder
    private var rightPaneBody: some View {
        switch rightPane {
        case .empty:
            SpecDetailView(spec: nil)
        case .spec(let spec):
            SpecDetailView(spec: spec)
        case .pty(let sessionId, let fromSpec):
            PtyViewer(
                sessionId: sessionId,
                sessionLabel: fromSpec.name,
                sessionMeta: "spec: \(fromSpec.project)/\(fromSpec.name)",
                sessionType: "managed",
                onClose: {
                    // Back-arrow returns to the detail view of the spec
                    // the PTY was started from. Matches the proposal's
                    // "closing the PTY returns the right pane to the
                    // spec detail it was on before" contract.
                    rightPane = .spec(fromSpec)
                }
            )
        }
    }

    /// Start Session click handler (specs-tab-start-on-spec § 3.6).
    /// State machine:
    ///   1. Optimistically transition rightPane to `.pty(starting...)`.
    ///   2. Resolve the agent-side project path from the loaded
    ///      ProjectAggregate cache (sourced by `model.projectsForRow`).
    ///   3. Call `client.startSession(project, path, specSlug: spec.name)`.
    ///   4. On success: swap the placeholder for the real session_id.
    ///   5. On failure: revert to `.spec(spec)` + surface `startError`.
    private func startSession(for spec: SpecSummary) async {
        startError = nil
        // Resolve project path from the model's projects cache. The
        // agent's POST /session/start requires a real on-disk path; we
        // refuse to start when we don't know it (rather than guess).
        guard let projectPath = model.projectPath(forCode: spec.project) else {
            startError = "Unknown project path for '\(spec.project)' — register the project in agents.toml or refresh."
            return
        }
        rightPane = .pty(sessionId: SpecsViewStartingSessionPlaceholder, fromSpec: spec)
        do {
            let response = try await model.startSession(
                project: spec.project,
                path: projectPath,
                specSlug: spec.name
            )
            let sid = response.sessionId ?? response.sessionName
            rightPane = .pty(sessionId: sid, fromSpec: spec)
            // Refresh linked-session count so the row's start button
            // disables instantly without waiting on SSE.
            await model.refreshLinkedSessions(for: spec)
        } catch {
            // Revert and surface the failure. SpecDetailView still has
            // the spec selected so the user can retry.
            rightPane = .spec(spec)
            startError = "Start failed: \(String(describing: error))"
        }
    }

    private var leftPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if let err = startError {
                Text(err)
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
                    .lineLimit(3)
                    .padding(.horizontal, 14)
                    .accessibilityIdentifier("specs-view-start-error")
            }
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
                                waveStatus: model.wavePlan?.lookupSpec(name: spec.name),
                                linkedSessions: model.linkedSessions(for: spec),
                                onStartSession: { Task { await startSession(for: spec) } }
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
                unlinkedBeadsSection
            }
        }
    }

    /// "Unlinked open beads" section — open/in-progress beads with no
    /// proposal link (unplanned work). Hidden entirely when every project
    /// reports zero unlinked beads. specs-tab · add-bead-proposal-roadmap-
    /// surface task 2.3.
    @ViewBuilder
    private var unlinkedBeadsSection: some View {
        let rows = model.unlinkedRows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("UNLINKED OPEN BEADS")
                    .font(.system(.caption2, design: .monospaced))
                    .tracking(1.5)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                ForEach(rows, id: \.bead.id) { row in
                    UnlinkedBeadRow(project: row.project, bead: row.bead)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .accessibilityIdentifier("specs-view-unlinked-beads")
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
    /// Cached `spec_sessions` linkage rows for this spec, fetched lazily
    /// by SpecsViewModel. specs-tab-start-on-spec § 3.6 — when ≥1 active
    /// row is present, the Start Session button is disabled (tooltip
    /// lists existing session ids).
    var linkedSessions: [SpecSession] = []
    /// Callback fired when the user taps Start Session.
    var onStartSession: () -> Void = {}

    private var hasActiveSession: Bool {
        linkedSessions.contains(where: \.active)
    }

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
                beadRollupRow
            }
            Spacer()
            startSessionButton
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(
            isSelected
                ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                : AnyShapeStyle(Color.clear)
        )
    }

    /// Bead-rollup adornment row: a thin progress bar (`closed/total` task
    /// beads), a ready-count chip, and tappable epic/feature bead ids.
    /// Hidden entirely when the agent shipped no rollup (older agent, or a
    /// project with no `.beads/` dir) — add-bead-proposal-roadmap-surface
    /// task 2.3 "gracefully handle beadRollup == nil".
    @ViewBuilder
    private var beadRollupRow: some View {
        if let rollup = spec.beadRollup {
            HStack(spacing: 8) {
                ProgressView(value: rollup.progress)
                    .progressViewStyle(.linear)
                    .frame(width: 80)
                Text("\(rollup.tasks.closed)/\(rollup.tasks.total)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                if rollup.tasks.ready > 0 {
                    ReadyCountChip(count: rollup.tasks.ready)
                }
                if let epic = rollup.epic {
                    BeadIdChip(ref: epic, role: "epic")
                }
                if let feature = rollup.feature {
                    BeadIdChip(ref: feature, role: "feature")
                }
            }
            .accessibilityIdentifier("spec-row-bead-rollup-\(spec.name)")
        }
    }

    /// Per-row Start Session button. Disabled when ≥1 linked session is
    /// active; tooltip surfaces the live session ids so the user can find
    /// them via Sessions tab instead of double-spawning.
    private var startSessionButton: some View {
        Button {
            onStartSession()
        } label: {
            Image(systemName: "play.circle.fill")
                .font(.system(size: 16, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
        }
        .buttonStyle(.borderless)
        .disabled(hasActiveSession)
        .help(
            hasActiveSession
                ? "Already running: \(linkedSessions.filter(\.active).map(\.sessionId).joined(separator: ", "))"
                : "Start Session"
        )
        .accessibilityLabel("Start Session for \(spec.name)")
        .accessibilityIdentifier("spec-row-start-session-\(spec.name)")
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
    /// Per-spec linked-session cache keyed by SpecSummary.id
    /// (`"<project>/<name>"`). Populated lazily — only the rows the user
    /// hovers/expands get a fetch — so the Specs tab keeps its <500ms
    /// first paint. specs-tab-start-on-spec § 3.6 disables the row Start
    /// Session button when any cached entry has `active: true`.
    @Published private(set) var linkedSessionsBySpec: [String: [SpecSession]] = [:]
    /// Project code → on-disk path cache sourced from
    /// `client.fetchProjects()`. Used by Start Session to resolve the
    /// agent's POST /session/start `path` field.
    @Published private(set) var projectPaths: [String: String] = [:]
    /// Unlinked (unplanned) open beads per project, fed by
    /// `GET /beads/unlinked?project=` (add-bead-proposal-roadmap-surface
    /// task 2.3). Fetched best-effort during `load()`; a 404 / failure
    /// simply leaves a project absent so the section stays empty.
    @Published private(set) var unlinkedByProject: [String: [UnlinkedBead]] = [:]

    /// Flattened `(project, bead)` pairs for the "Unlinked open beads"
    /// section, project-then-priority ordered.
    var unlinkedRows: [(project: String, bead: UnlinkedBead)] {
        unlinkedByProject
            .sorted { $0.key < $1.key }
            .flatMap { project, beads in
                beads
                    .sorted { $0.priority != $1.priority ? $0.priority < $1.priority : $0.id < $1.id }
                    .map { (project, $0) }
            }
    }

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
        // Fetch specs + wave plan + projects concurrently. Projects feeds
        // the `projectPaths` cache so Start Session can resolve a real
        // on-disk path without a follow-up fetch (the agent's
        // /session/start endpoint requires it).
        async let specsFetch = client.fetchSpecs()
        async let wavePlanFetch = client.fetchWavePlanStatus()
        async let projectsFetch = client.fetchProjects()
        self.specs = await specsFetch
        self.wavePlan = await wavePlanFetch
        let projects = await projectsFetch
        var paths: [String: String] = [:]
        for p in projects {
            // ProjectAggregate.id is the project code; .path (when present)
            // is the agent-side filesystem location. Skip entries without a
            // path — Start Session falls back to a user-facing error in
            // that case rather than guessing.
            if let path = projectAggregatePath(p), !path.isEmpty {
                paths[p.id] = path
            }
        }
        self.projectPaths = paths
        await loadUnlinkedBeads()
    }

    /// Fan out `fetchUnlinkedBeads` for each distinct project in the loaded
    /// spec list. Best-effort — the aggregate client already swallows
    /// per-agent failures, and a project with no unlinked beads just maps to
    /// an empty array (dropped from `unlinkedRows`).
    private func loadUnlinkedBeads() async {
        let projects = Set(specs.map(\.project))
        var byProject: [String: [UnlinkedBead]] = [:]
        await withTaskGroup(of: (String, [UnlinkedBead]).self) { group in
            for project in projects {
                group.addTask { [client] in
                    (project, await client.fetchUnlinkedBeads(project: project))
                }
            }
            for await (project, beads) in group where !beads.isEmpty {
                byProject[project] = beads
            }
        }
        self.unlinkedByProject = byProject
    }

    /// Best-effort accessor for ProjectAggregate.path — the model evolved
    /// over time and old aggregates may not carry the field. We treat
    /// missing as nil so Start Session surfaces a clean "unknown project"
    /// error instead of crashing.
    private func projectAggregatePath(_ p: ProjectAggregate) -> String? {
        // ProjectAggregate exposes `path` directly when present. The
        // optional cast keeps this resilient if the field is later removed
        // or renamed (this view degrades to "manual path" entry rather
        // than crashing).
        let mirror = Mirror(reflecting: p)
        for child in mirror.children {
            if child.label == "path", let s = child.value as? String {
                return s
            }
            if child.label == "path", let s = child.value as? String? {
                return s
            }
        }
        return nil
    }

    func projectPath(forCode code: String) -> String? {
        projectPaths[code]
    }

    /// Read-side accessor used by `SpecRow` to render the disabled-state
    /// tooltip. Returns the cached entry (may be empty) — never triggers
    /// a fetch (the row mount drives that via `prefetchLinkedSessions`).
    func linkedSessions(for spec: SpecSummary) -> [SpecSession] {
        linkedSessionsBySpec[spec.id] ?? []
    }

    /// Fan out `listSpecSessions` for a single spec and update the cache.
    /// Called by the row mount + after a successful start so the Start
    /// button disables/enables without waiting on SSE.
    func refreshLinkedSessions(for spec: SpecSummary) async {
        let rows = await client.listSpecSessions(
            project: spec.project,
            name: spec.name
        )
        linkedSessionsBySpec[spec.id] = rows
    }

    /// Thin pass-through so the view can call the aggregate client without
    /// holding it directly (keeps the actor inside the view-model).
    func startSession(
        project: String,
        path: String,
        specSlug: String
    ) async throws -> NexusShared.NexusClient.SessionStartResponse {
        try await client.startSession(
            project: project,
            path: path,
            specSlug: specSlug
        )
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
        // Agent emits `event: spec-transition` (SPEC_EVENTS_EVENT_NAME).
        // Pre-existing code matched `SpecTransition` (which never fired);
        // we accept both so a future agent rename doesn't silently regress.
        // specs-tab-start-on-spec § 3.7.
        guard event.name == "spec-transition" || event.name == "SpecTransition"
        else { return }
        latestTransition = "\(event.name)"
        // SpecTransition just signals "something moved" — refresh the
        // whole list rather than try to merge per-row. The list is small.
        // (specs-tab-start-on-spec § 3.7 — the status_change kind is also
        // covered by this branch; SpecSummary.status is the source of
        // truth so a full refresh always converges the row pill.)
        await load()
    }
}
