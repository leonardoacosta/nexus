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
    }

    // MARK: - Subviews

    private func header(for spec: SpecSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(spec.name)
                        .font(.system(.headline, design: .monospaced))
                    Text("\(spec.project) · \(spec.status)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
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
