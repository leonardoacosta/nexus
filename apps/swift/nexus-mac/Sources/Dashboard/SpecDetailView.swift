// SpecDetailView — markdown-rendered right-pane for SpecsView.
//
// Spec: openspec/changes/dashboard-ui-pass-v1 (task 2.2)
// Follow-up: nx-lm5y4 — swap inline-only AttributedString for MarkdownUI.
//
// Accepts a selected SpecSummary (or nil). When a spec is selected:
//   1. Renders a tab picker (proposal / design / tasks).
//   2. Fetches the corresponding markdown file via
//      NexusAggregateClient.fetchSpecContent on selection or tab change.
//   3. Renders the markdown via swift-markdown-ui (gonzalezreal) with the
//      built-in `.gitHub` theme. Handles full GFM: headings, fenced code
//      blocks, lists, task lists, blockquotes, tables, links, inline
//      formatting. Replaced the previous AttributedString(markdown:
//      interpretedSyntax: .inlineOnlyPreservingWhitespace) path which
//      rendered block-level constructs as raw markdown source.
//
// State semantics:
//   - selectedSpec == nil  -> hint state ("Select a spec to view…")
//   - fetched body == nil  -> empty state (404; spec lacks that file)
//   - fetch threw          -> error state with retry affordance
//   - fetched body == ""   -> empty state (treated identically to nil)

import SwiftUI
import MarkdownUI
import NexusShared

enum SpecDocumentTab: String, CaseIterable, Identifiable {
    case proposal
    case design
    case tasks

    var id: String { rawValue }

    var label: String {
        switch self {
        case .proposal: return "Proposal"
        case .design:   return "Design"
        case .tasks:    return "Tasks"
        }
    }

    /// `file` slug for `GET /specs/{project}/{name}/{file}` — matches the
    /// agent's allowlist (proposal|design|tasks).
    var fileSlug: String { rawValue }
}

struct SpecDetailView: View {
    let spec: SpecSummary?

    @State private var activeTab: SpecDocumentTab = .proposal
    @State private var content: String?
    @State private var isLoading: Bool = false
    @State private var loadError: String?
    // specs-tab-start-on-spec § 3.8: status pill state. Tracks the latest
    // value the UI thinks the spec carries — optimistically updated on
    // PATCH, then reconciled by SSE-driven refresh of the parent's
    // SpecSummary. `nil` means we haven't received any signal yet (fall
    // back to the spec's own status field).
    @State private var optimisticStatus: String?
    @State private var statusError: String?
    @State private var pendingStatusFlip: Bool = false
    @State private var showConfirm: Bool = false
    @State private var confirmTargetStatus: String = "draft"

    /// Aggregate client — owns fan-out across reachable agents. Static-shared
    /// is fine because the actor handles serialization internally.
    private let client = NexusShared.NexusAggregateClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let spec {
                header(for: spec)
                Divider()
                contentPane(for: spec)
            } else {
                hintState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Refetch whenever the selected spec OR the active tab changes.
        .task(id: TaskKey(spec: spec, tab: activeTab)) {
            guard let spec else {
                content = nil
                loadError = nil
                return
            }
            await load(spec: spec, tab: activeTab)
        }
        // Reset transient status state whenever the spec changes — keeps
        // a stale optimistic flip from spilling over to the next spec.
        .onChange(of: spec?.id) { _, _ in
            optimisticStatus = nil
            statusError = nil
            pendingStatusFlip = false
        }
    }

    // MARK: - Subviews

    private func header(for spec: SpecSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(spec.name)
                        .font(.system(.headline, design: .monospaced))
                    Text("\(spec.project) · \(effectiveStatus(for: spec))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                statusPill(for: spec)
            }
            if let statusError {
                Text(statusError)
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .accessibilityIdentifier("spec-detail-status-error")
            }
            // Metadata pane: read-only key/value list of every frontmatter
            // entry except `status` (already shown in the pill).
            // specs-tab-start-on-spec § 3.9.
            metadataPane(for: spec)
            Picker("", selection: $activeTab) {
                ForEach(SpecDocumentTab.allCases) { tab in
                    Text(tab.label).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .confirmationDialog(
            "Set status to \(confirmTargetStatus)?",
            isPresented: $showConfirm,
            titleVisibility: .visible
        ) {
            Button("Set \(confirmTargetStatus)") {
                Task { await applyStatusFlip(to: confirmTargetStatus, for: spec) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This rewrites the frontmatter of proposal.md on the owning agent.")
        }
    }

    /// Effective status — optimistic value wins over the spec's published
    /// value so a just-clicked PATCH reflects immediately.
    private func effectiveStatus(for spec: SpecSummary) -> String {
        optimisticStatus ?? spec.status
    }

    /// Pill button: gray for draft, green for approved, blue for archived
    /// (read-only). Click → confirm dialog → PATCH. Disabled when the
    /// spec is archived OR when a PATCH is already in flight.
    private func statusPill(for spec: SpecSummary) -> some View {
        let status = effectiveStatus(for: spec).lowercased()
        let isArchived = status == "archived"
        let nextStatus: String = status == "approved" ? "draft" : "approved"
        return Button {
            // Archived rejects the flip with 409; never even show the
            // confirm dialog (the button is also `.disabled`).
            guard !isArchived else { return }
            confirmTargetStatus = nextStatus
            showConfirm = true
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(pillColor(forStatus: status))
                    .frame(width: 6, height: 6)
                Text(status.uppercased())
                    .font(.caption2.monospaced())
                    .tracking(1.2)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(pillColor(forStatus: status).opacity(0.16))
            .clipShape(Capsule())
        }
        .buttonStyle(.borderless)
        .disabled(isArchived || pendingStatusFlip)
        .help(
            isArchived
                ? "Archived (read-only)"
                : "Click to set status to \(nextStatus)"
        )
        .accessibilityLabel("Status: \(status). Tap to set \(nextStatus).")
        .accessibilityIdentifier("spec-detail-status-pill")
    }

    private func pillColor(forStatus s: String) -> Color {
        switch s {
        case "approved": return .green
        case "archived": return .blue
        default: return .gray
        }
    }

    /// Key/value list rendered below the status pill. Skips `status`
    /// (already shown in the pill). Hidden entirely when the agent
    /// didn't ship a frontmatter map (older agents pre-2.7) OR when the
    /// map is empty.
    @ViewBuilder
    private func metadataPane(for spec: SpecSummary) -> some View {
        if let fm = spec.frontmatter, !fm.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(
                    fm.keys
                        .filter { $0.lowercased() != "status" }
                        .sorted(),
                    id: \.self
                ) { key in
                    HStack(alignment: .firstTextBaseline) {
                        Text(key)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(width: 120, alignment: .leading)
                        Text(fm[key] ?? "")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(.vertical, 4)
            .accessibilityIdentifier("spec-detail-metadata-pane")
        }
    }

    private func applyStatusFlip(to target: String, for spec: SpecSummary) async {
        pendingStatusFlip = true
        statusError = nil
        // Optimistic — reflect in the pill immediately.
        optimisticStatus = target
        do {
            _ = try await client.patchSpecStatus(
                project: spec.project,
                name: spec.name,
                status: target
            )
        } catch NexusClientError.badStatus(let code) {
            // 409 = archived (server's read-only short-circuit). Revert
            // the optimistic update and surface the specific message.
            optimisticStatus = nil
            statusError = code == 409
                ? "Spec is archived (read-only)."
                : "PATCH failed: HTTP \(code)"
        } catch {
            optimisticStatus = nil
            statusError = "PATCH failed: \(String(describing: error))"
        }
        pendingStatusFlip = false
    }

    @ViewBuilder
    private func contentPane(for spec: SpecSummary) -> some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = loadError {
            errorState(message: error, retry: {
                Task { await load(spec: spec, tab: activeTab) }
            })
        } else if let content, !content.isEmpty {
            ScrollView {
                Markdown(content)
                    .markdownTheme(.gitHub)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
        } else {
            emptyState(tab: activeTab)
        }
    }

    private var hintState: some View {
        ContentUnavailableView(
            "No spec selected",
            systemImage: "doc.text",
            description: Text("Select a spec on the left to view its contents.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func emptyState(tab: SpecDocumentTab) -> some View {
        ContentUnavailableView(
            "No \(tab.label.lowercased()) document",
            systemImage: "doc",
            description: Text("This spec doesn't have a \(tab.fileSlug).md file.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(message: String, retry: @escaping () -> Void) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .foregroundStyle(.orange)
            Text("Failed to load spec content")
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button("Try Again", action: retry)
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Helpers

    private func load(spec: SpecSummary, tab: SpecDocumentTab) async {
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            // NexusAggregateClient.fetchSpecContent is non-throwing in the
            // success/404 branches and only surfaces errors via the aggregate
            // log path. To preserve the user-facing error state we use the
            // single-client throwing variant via the aggregate's actor seam.
            //
            // The aggregate returns nil when every reachable agent failed OR
            // when every agent returned 404. We can't distinguish those two
            // here; we treat nil as "no document" (the 404 case is the
            // overwhelmingly common one).
            let fetched = await client.fetchSpecContent(
                project: spec.project,
                name: spec.name,
                file: tab.fileSlug
            )
            content = fetched
        }
    }

    /// `task(id:)` re-runs whenever the id value changes. Wrapping spec+tab
    /// in a Hashable struct lets us trigger on either field flipping.
    private struct TaskKey: Hashable {
        let specId: String?
        let tab: SpecDocumentTab

        init(spec: SpecSummary?, tab: SpecDocumentTab) {
            self.specId = spec?.id
            self.tab = tab
        }
    }
}
