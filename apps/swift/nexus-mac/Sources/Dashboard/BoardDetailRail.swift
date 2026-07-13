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
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(o.bead.id).font(.caption2.monospaced()).foregroundStyle(Color.nx.ink3)
                BoardBadge(kind: o.bead.type.lowercased() == "bug" ? .bug : .orphan)
                PriorityPill(priority: o.bead.priority)
                Spacer()
            }
            Text(o.bead.title)
                .font(.system(.headline, design: .monospaced))
                .foregroundStyle(Color.nx.ink)
            if let project = o.bead.project {
                Text("\(project) · \(o.bead.status)")
                    .font(.caption).foregroundStyle(Color.nx.ink3)
            }
            detailSection("Description")
            Text(o.bead.description ?? "Unplanned work — not referenced by any live proposal's tasks.md.")
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

@MainActor
final class BoardDetailModel: ObservableObject {
    @Published var tab: SpecDocTab = .proposal
    @Published private(set) var content: String?
    @Published private(set) var isLoadingContent = false
    @Published private(set) var actionInFlight = false
    @Published private(set) var actionError: String?

    private let client = NexusShared.NexusAggregateClient()

    func loadContent(project: String, slug: String) async {
        isLoadingContent = true
        defer { isLoadingContent = false }
        content = await client.fetchSpecContent(
            project: project, name: slug, file: tab.rawValue
        )
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
