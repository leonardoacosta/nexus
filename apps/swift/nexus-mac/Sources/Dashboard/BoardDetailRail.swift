// BoardDetailRail — the board's right-hand inspector (design § 01).
//
// Spec: openspec/changes/refocus-board-shell (task 3.1)
//
// Absorbs what the deleted SpecDetailView rendered — spec markdown
// (proposal / design / tasks tabs via `GET /specs/.../{file}` + MarkdownUI),
// the linked-bead task/dep list, recent TTS for the owning project, and the
// approve / reject + attach actions. For an orphan bead it degrades to the
// bead's own description + status (no spec content exists to fetch).

import SwiftUI
import MarkdownUI
import NexusShared

struct BoardDetailRail: View {
    let item: BoardWorkItem?
    /// Live sessions (for the Attach affordance). Filtered to the item's
    /// project inside.
    let sessions: [Session]
    /// Recent notification/TTS history (filtered to the project inside).
    let notifications: [NotificationEvent]
    /// Latest fleet-wide bead transition (published by `SessionObserver`).
    /// Drives live-refresh of a selected orphan bead when it targets the
    /// orphan's project. Spec: add-board-detail-live-updates (orphan detail
    /// live-refresh via existing BeadTransition).
    let lastBeadTransition: BeadTransition?
    /// Summon the attach sheet for a session (owned by the board shell).
    var onAttach: (Session) -> Void

    @StateObject private var model = BoardDetailModel()

    var body: some View {
        Group {
            switch item {
            case .some(.proposal(let p)): proposalDetail(p)
            case .some(.orphan(let o)):   orphanDetail(o)
            case .none:                   emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.nx.substrate2)
        // Bind (or tear down) the single live SSE connection on a genuine
        // (de)selection — keyed on the stable selection token, not the whole
        // item, so a background board reload of the same row never churns the
        // connection. `initial: true` fires on first appearance too.
        .onChange(of: BoardSelectionToken(item: item), initial: true) { _, token in
            model.updateSelection(token)
        }
        // A fleet-wide bead transition may target the selected orphan's project.
        .onChange(of: lastBeadTransition) { _, transition in
            if let transition { model.handleBeadTransition(transition) }
        }
        .onDisappear { model.teardown() }
    }

    // MARK: - Empty

    private var emptyState: some View {
        ContentUnavailableView(
            "Nothing selected",
            systemImage: "sidebar.right",
            description: Text("Pick a proposal or orphan on the board to inspect it.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Proposal

    private func proposalDetail(_ p: BoardProposal) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header(for: p)
                    if let err = model.actionError {
                        Text(err)
                            .font(.caption.monospaced())
                            .foregroundStyle(Color.nx.critical)
                            .accessibilityIdentifier("board-detail-action-error")
                    }
                    tasksSection(p)
                    depsSection(p)
                    recentTTSSection(project: p.project)
                    Divider().overlay(Color.nx.hairline)
                    Picker("", selection: $model.tab) {
                        ForEach(SpecDocTab.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    specContent
                }
                .padding(16)
            }
            actions(for: p)
        }
        .task(id: DetailKey(project: p.project, slug: p.proposal.slug, tab: model.tab)) {
            await model.loadContent(project: p.project, slug: p.proposal.slug)
        }
        .onChange(of: p.id) { _, _ in model.resetAction() }
    }

    private func header(for p: BoardProposal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let epic = p.rollup.epic {
                    Text(epic.id).font(.caption2.monospaced()).foregroundStyle(Color.nx.ink3)
                }
                BoardBadge(kind: .proposal)
                PriorityPill(priority: p.priority)
                Spacer()
                cacheStateIndicator
            }
            Text(p.proposal.slug)
                .font(.system(.headline, design: .monospaced))
                .foregroundStyle(Color.nx.ink)
            Text("\(p.project) · \(p.capabilityName) · \(p.proposal.specStatus)")
                .font(.caption)
                .foregroundStyle(Color.nx.ink3)
        }
    }

    @ViewBuilder
    private func tasksSection(_ p: BoardProposal) -> some View {
        let t = p.rollup.tasks
        detailSection("Tasks · \(t.closed)/\(t.total)")
        VStack(alignment: .leading, spacing: 3) {
            let taskBeads = p.rollup.beads.filter { $0.type == "task" }
            if taskBeads.isEmpty {
                Text("No linked task beads.")
                    .font(.caption2).foregroundStyle(Color.nx.ink4)
            } else {
                ForEach(taskBeads.prefix(12)) { bead in
                    HStack(spacing: 6) {
                        BeadStatusGlyph(status: bead.status)
                        Text(bead.id).font(.caption2.monospaced())
                            .foregroundStyle(Color.nx.ink3)
                        Text(bead.title).font(.caption2)
                            .foregroundStyle(Color.nx.ink2)
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func depsSection(_ p: BoardProposal) -> some View {
        if let feature = p.rollup.feature {
            detailSection("Feature")
            HStack(spacing: 6) {
                BeadStatusGlyph(status: feature.status)
                Text(feature.id).font(.caption2.monospaced())
                    .foregroundStyle(Color.nx.ink3)
                Text(feature.title).font(.caption2)
                    .foregroundStyle(Color.nx.ink2)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func recentTTSSection(project: String) -> some View {
        let recent = notifications
            .filter { ($0.project ?? "").isEmpty || $0.project == project }
            .prefix(4)
        if !recent.isEmpty {
            detailSection("Recent TTS")
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(recent)) { ev in
                    HStack(alignment: .top, spacing: 6) {
                        Text(ev.title?.isEmpty == false ? ev.title! : ev.body)
                            .font(.caption2)
                            .foregroundStyle(Color.nx.ink2)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Text(ev.receivedAt, style: .relative)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(Color.nx.ink4)
                    }
                }
            }
        }
    }

    /// Small, unobtrusive freshness indicator for the selected proposal's spec
    /// content (detail rail only — never on board rows):
    ///   - cached-only    → a dim dot (showing stale/prefetched content)
    ///   - fetch-in-flight → a small ProgressView
    ///   - fresh          → a phosphor checkmark + relative timestamp
    @ViewBuilder
    private var cacheStateIndicator: some View {
        switch model.cacheState {
        case .cachedOnly:
            Circle()
                .fill(Color.nx.ink4)
                .frame(width: 6, height: 6)
                .help("Showing cached content")
                .accessibilityIdentifier("board-detail-cache-cached")
        case .fetchInFlight:
            ProgressView()
                .controlSize(.mini)
                .accessibilityIdentifier("board-detail-cache-fetching")
        case .fresh(let at):
            HStack(spacing: 4) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Color.nx.phosphorDim)
                Text(at, style: .relative)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Color.nx.ink4)
            }
            .accessibilityIdentifier("board-detail-cache-fresh")
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder
    private var specContent: some View {
        if model.isLoadingContent {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12)
        } else if let body = model.content, !body.isEmpty {
            Markdown(body)
                .markdownTheme(.gitHub)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text("No \(model.tab.label.lowercased()).md for this proposal.")
                .font(.caption2)
                .foregroundStyle(Color.nx.ink4)
                .padding(.vertical, 8)
        }
    }

    private func actions(for p: BoardProposal) -> some View {
        HStack(spacing: 8) {
            Button {
                Task { await model.approve(project: p.project, slug: p.proposal.slug) }
            } label: { Text("Approve").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent)
                .tint(Color.nx.phosphorDim)
                .disabled(model.actionInFlight)
                .accessibilityIdentifier("board-detail-approve")

            Button {
                Task { await model.reject(project: p.project, slug: p.proposal.slug) }
            } label: { Text("Reject").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered)
                .disabled(model.actionInFlight)
                .accessibilityIdentifier("board-detail-reject")

            if let session = liveSession(for: p.project) {
                Button {
                    onAttach(session)
                } label: { Image(systemName: "rectangle.on.rectangle") }
                    .buttonStyle(.bordered)
                    .help("Attach to the session running this project")
                    .accessibilityIdentifier("board-detail-attach")
            }
        }
        .padding(12)
        .background(Color.nx.substrate3)
    }

    // MARK: - Orphan

    private func orphanDetail(_ o: BoardOrphan) -> some View {
        // Prefer a post-transition refetch of this bead over the passed-in row
        // so a matching BeadTransition re-renders fresh status/description.
        let bead = model.orphanBead(default: o.bead)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(bead.id).font(.caption2.monospaced()).foregroundStyle(Color.nx.ink3)
                BoardBadge(kind: bead.type.lowercased() == "bug" ? .bug : .orphan)
                PriorityPill(priority: bead.priority)
                Spacer()
            }
            Text(bead.title)
                .font(.system(.headline, design: .monospaced))
                .foregroundStyle(Color.nx.ink)
            if let project = bead.project {
                Text("\(project) · \(bead.status)")
                    .font(.caption).foregroundStyle(Color.nx.ink3)
            }
            detailSection("Description")
            Text(bead.description ?? "Unplanned work — not referenced by any live proposal's tasks.md.")
                .font(.caption)
                .foregroundStyle(Color.nx.ink2)
                .textSelection(.enabled)
            Spacer()
        }
        .padding(16)
    }

    // MARK: - Helpers

    private func detailSection(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
            .tracking(1.8)
            .foregroundStyle(Color.nx.ink4)
            .padding(.top, 6)
    }

    private func liveSession(for project: String) -> Session? {
        sessions.first { ($0.machine ?? "").isEmpty == false && Session.projectLabel(for: $0).localizedCaseInsensitiveContains(project) }
            ?? sessions.first
    }

    private struct DetailKey: Hashable {
        let project: String
        let slug: String
        let tab: SpecDocTab
    }
}

/// Proposal / design / tasks document tab — file slug matches the agent's
/// `GET /specs/{project}/{name}/{file}` allowlist.
enum SpecDocTab: String, CaseIterable, Identifiable {
    case proposal, design, tasks
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

/// Stable selection identity the detail rail keys its live-connection lifecycle
/// on. Unlike the full `BoardWorkItem` (whose embedded rollup counts churn on
/// every board reload), this only flips when the *selected item itself* changes
/// — so the SSE connection is opened/closed on a genuine (de)selection, never
/// on a background data refresh of the same row.
enum BoardSelectionToken: Equatable {
    case proposal(project: String, slug: String)
    case orphan(id: String, project: String)
    case none

    init(item: BoardWorkItem?) {
        switch item {
        case .some(.proposal(let p)):
            self = .proposal(project: p.project, slug: p.proposal.slug)
        case .some(.orphan(let o)):
            self = .orphan(id: o.bead.id, project: o.bead.project ?? "")
        case .none:
            self = .none
        }
    }
}

/// Lightweight decode of the `GET /specs/events` SSE frame — we only need each
/// coalesced event's (project, spec) to decide whether it targets the open
/// item. Extra fields (`kind`, `completed`, `total`, `to`) are ignored by
/// `Decodable`. Wire shape: `@nexus/core` `specEventsFrameSchema`.
private struct SpecEventsFrameLite: Decodable {
    struct Item: Decodable {
        let project: String
        let spec: String
    }
    let events: [Item]
}

@MainActor
final class BoardDetailModel: ObservableObject {
    @Published var tab: SpecDocTab = .proposal
    @Published private(set) var content: String?
    /// Cache freshness of the currently-shown spec content — drives the
    /// detail-rail indicator. nil before the first fetch resolves.
    @Published private(set) var cacheState: SpecContentCache.CacheState?
    @Published private(set) var actionInFlight = false
    @Published private(set) var actionError: String?
    /// Fresh copy of the selected orphan bead, pulled after a matching
    /// `BeadTransition`. `orphanBead(default:)` prefers it over the passed-in
    /// row so the detail re-renders with post-transition state.
    @Published private(set) var orphanOverride: UnlinkedBead?

    private let client: NexusAggregateClient
    private let cache: SpecContentCache
    /// Live-update source — the same aggregate in production, a fake in tests.
    private let live: any SpecLiveUpdating
    /// Content fetcher backing both the initial load and live revalidation.
    /// Injectable so tests can assert revalidation without networking.
    private let contentFetcher: SpecContentCache.Fetcher

    /// The single open SSE connection to the selected proposal's owning agent.
    /// Cancelled before any new connection opens (deselect / different row).
    private var liveTask: Task<Void, Never>?
    /// In-flight revalidation stream, cancelled before a new one starts so
    /// overlapping server pushes don't interleave into `content`.
    private var revalidateTask: Task<Void, Never>?
    /// The proposal the live connection is bound to; a received `SpecTransition`
    /// only triggers a revalidation when it matches this (project, slug).
    private var openProposal: (project: String, slug: String)?
    /// The currently-selected orphan bead's (id, project), when an orphan is
    /// selected. Drives `BeadTransition`-matched refetch.
    private var openOrphan: (id: String, project: String)?

    init(
        cache: SpecContentCache = .shared,
        client: NexusAggregateClient? = nil,
        live: (any SpecLiveUpdating)? = nil,
        contentFetcher: SpecContentCache.Fetcher? = nil
    ) {
        let aggregate = client ?? NexusAggregateClient()
        self.client = aggregate
        self.cache = cache
        self.live = live ?? aggregate
        self.contentFetcher = contentFetcher ?? { key in
            await aggregate.fetchSpecContent(
                project: key.project, name: key.slug, file: key.file
            )
        }
    }

    /// Show a blocking spinner ONLY when there is nothing cached to render yet
    /// and a fetch is running — the stale-while-revalidate win is that cached
    /// content stays on screen (no spinner) while a refresh runs underneath.
    var isLoadingContent: Bool {
        content == nil && cacheState == .fetchInFlight
    }

    /// Read the selected spec's content through the cache: renders cached
    /// content immediately (as `.cachedOnly`) if present, then updates in place
    /// as the background revalidation resolves. The `for await` loop tears down
    /// via SwiftUI `.task(id:)` cancellation when the selection/tab changes.
    func loadContent(project: String, slug: String) async {
        let key = SpecContentCache.CacheKey(project: project, slug: slug, file: tab.rawValue)
        for await snap in cache.fetch(key: key, using: contentFetcher) {
            content = snap.content
            cacheState = snap.state
        }
    }

    // MARK: - Live spec-events connection (add-board-detail-live-updates)

    /// React to a selection change: bind (or tear down) the live connection.
    /// Called from the rail's top-level `.onChange(of:initial:)` so it fires on
    /// first appearance and every genuine (de)selection.
    func updateSelection(_ token: BoardSelectionToken) {
        switch token {
        case .proposal(let project, let slug):
            closeOrphan()
            openLiveConnection(project: project, slug: slug)
        case .orphan(let id, let project):
            closeLiveConnection()
            bindOrphan(id: id, project: project)
        case .none:
            teardown()
        }
    }

    /// Cancel any open connections/streams when the rail disappears.
    func teardown() {
        closeLiveConnection()
        closeOrphan()
    }

    /// Open exactly ONE SSE connection to the selected proposal's owning agent.
    /// Cancels the previous connection BEFORE opening the new one so a rapid
    /// row-switch never leaves two streams live at once.
    func openLiveConnection(project: String, slug: String) {
        liveTask?.cancel()
        openProposal = (project, slug)
        let live = self.live
        liveTask = Task { [weak self] in
            guard let owner = await live.resolveOwningAgent(project: project) else { return }
            if Task.isCancelled { return }
            await live.streamSpecEvents(
                from: owner,
                onConnect: { [weak self] isReconnect in
                    // Reconnect → one catch-up revalidation for transitions
                    // missed while disconnected. Skip the first connect (the
                    // selection's own `.task` load already fetched fresh).
                    guard isReconnect else { return }
                    await self?.revalidateOpenProposal(project: project, slug: slug)
                },
                handler: { [weak self] event in
                    await self?.handleSpecEvent(event, project: project, slug: slug)
                }
            )
        }
    }

    /// Cancel the open SSE connection (deselection / different-row selection).
    func closeLiveConnection() {
        liveTask?.cancel()
        liveTask = nil
        revalidateTask?.cancel()
        revalidateTask = nil
        openProposal = nil
    }

    /// Decode a `spec-transition` frame; if any coalesced event targets the
    /// open (project, slug), invalidate + revalidate the matching cache entry.
    /// Events for any other (project, slug) are ignored.
    func handleSpecEvent(_ event: SSEEvent, project: String, slug: String) async {
        guard let bytes = event.data.data(using: .utf8),
              let frame = try? JSONDecoder().decode(SpecEventsFrameLite.self, from: bytes)
        else { return }
        let targetsOpen = frame.events.contains {
            $0.project == project && $0.spec == slug
        }
        guard targetsOpen else { return }
        await revalidateOpenProposal(project: project, slug: slug)
    }

    /// Re-run the cache fetch for the open proposal's current tab — the same
    /// stale-while-revalidate path `loadContent` uses (no second data path).
    /// No-op when the selection has since moved off (project, slug).
    private func revalidateOpenProposal(project: String, slug: String) async {
        guard let open = openProposal, open.project == project, open.slug == slug else {
            return
        }
        revalidateTask?.cancel()
        let key = SpecContentCache.CacheKey(project: project, slug: slug, file: tab.rawValue)
        let cache = self.cache
        let fetcher = self.contentFetcher
        revalidateTask = Task { [weak self] in
            for await snap in cache.fetch(key: key, using: fetcher) {
                if Task.isCancelled { return }
                self?.content = snap.content
                self?.cacheState = snap.state
            }
        }
        await revalidateTask?.value
    }

    // MARK: - Orphan live-refresh via BeadTransition (add-board-detail-live-updates)

    /// Bind the selected orphan so a matching `BeadTransition` triggers a
    /// refetch. Clears any stale override from a previous orphan.
    private func bindOrphan(id: String, project: String) {
        openOrphan = (id, project)
        orphanOverride = nil
    }

    private func closeOrphan() {
        openOrphan = nil
        orphanOverride = nil
    }

    /// Fresh bead to render for orphan `id`, or the passed-in fallback when no
    /// post-transition refetch has landed for it.
    func orphanBead(default fallback: UnlinkedBead) -> UnlinkedBead {
        if let override = orphanOverride, override.id == fallback.id { return override }
        return fallback
    }

    /// A fleet-wide `BeadTransition` arrived (published by `SessionObserver`).
    /// When it matches the selected orphan's project, refetch that project's
    /// unlinked beads and surface the fresh copy of the open orphan.
    func handleBeadTransition(_ transition: BeadTransition) {
        guard let orphan = openOrphan, orphan.project == transition.project else { return }
        let id = orphan.id
        let project = orphan.project
        let client = self.client
        Task { [weak self] in
            let fresh = await client.fetchUnlinkedBeads(project: project)
            guard let match = fresh.first(where: { $0.id == id }) else { return }
            // Ignore if the selection moved off this orphan while fetching.
            guard self?.openOrphan?.id == id else { return }
            self?.orphanOverride = match
        }
    }

    func approve(project: String, slug: String) async {
        await runAction { try await self.client.approveSpec(project: project, name: slug) }
    }

    func reject(project: String, slug: String) async {
        await runAction { try await self.client.rejectSpec(project: project, name: slug) }
    }

    func resetAction() {
        actionError = nil
        actionInFlight = false
    }

    private func runAction(_ body: @escaping () async throws -> Bool) async {
        actionInFlight = true
        actionError = nil
        defer { actionInFlight = false }
        do {
            _ = try await body()
        } catch NexusClientError.badStatus(let code) {
            actionError = "Failed: HTTP \(code)"
        } catch {
            actionError = "Failed: \(String(describing: error))"
        }
    }
}
