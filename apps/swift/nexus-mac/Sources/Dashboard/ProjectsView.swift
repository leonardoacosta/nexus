// ProjectsView — macOS dashboard parity for apps/nextjs/src/app/projects.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.4)
//       openspec/changes/projects-tab-accordion-deeplink (task 2.6)
//
// Each project renders as an expandable `ProjectAccordionRow` carrying
// git metadata + a nested live-session list. Sticky expand state via
// `@AppStorage` keyed by project id; orphan keys are pruned on `.task()`.
//
// Sessions are sourced from the shared `SessionObserver` injected at
// scene root so list refreshes don't fan out duplicate /sessions polls.

import SwiftUI
import NexusShared

struct ProjectsView: View {
    @StateObject private var model = ProjectsViewModel()
    /// Shared with SessionsView/SpecsView at scene root. Used to source
    /// the live session list per project for the accordion expansion.
    @ObservedObject private var sessionObserver: SessionObserver

    init(sessionObserver: SessionObserver) {
        self.sessionObserver = sessionObserver
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.projects.isEmpty {
                ContentUnavailableView(
                    "No projects",
                    systemImage: "folder",
                    description: Text(model.isLoading ? "Loading…" : "No projects discovered yet.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                listBody
            }
        }
        .padding(.vertical, 8)
        .task {
            await model.load()
            // Orphan @AppStorage pruning — drop stored expand state for
            // projects that no longer exist in the registry. O(N) over
            // UserDefaults keys with the namespaced prefix; cheap and
            // bounded. Spec: projects-tab-accordion-deeplink § task 2.6.
            ProjectsView.pruneOrphanExpandKeys(liveIds: Set(model.projects.map(\.id)))
        }
    }

    private var header: some View {
        HStack {
            Text("PROJECTS")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(model.projects.count)")
                .font(.system(.caption2, design: .monospaced))
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
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(model.projects) { project in
                    accordionRow(project)
                        .contextMenu {
                            // Remove affordance only composes when the row
                            // carries a registry UUID — `PATCH /projects/:id`
                            // validates a strict UUID. Session-only buckets
                            // (id == nil) have nothing to hide server-side.
                            if project.projectID != nil {
                                Button(role: .destructive) {
                                    Task { await model.remove(project) }
                                } label: {
                                    Label("Remove project", systemImage: "eye.slash")
                                }
                            }
                        }
                        .accessibilityIdentifier("project-row-\(project.id)")
                    Divider().padding(.leading, 14)
                }
            }
        }
    }

    @ViewBuilder
    private func accordionRow(_ project: ProjectAggregate) -> some View {
        let sessions = sessionsFor(project)
        // @AppStorage doesn't support dynamic keys via property wrapper —
        // bridge via a binding-backed lookup helper that reads/writes
        // UserDefaults directly. Default-state logic:
        //   - explicit stored value → honour it
        //   - no stored value && activeSessions > 0 → default expanded
        //   - no stored value && activeSessions == 0 → default collapsed
        let key = Self.expandKey(for: project.id)
        let stored = UserDefaults.standard.object(forKey: key) as? Bool
        let defaultExpanded = project.activeSessions > 0
        let isExpandedBinding = Binding<Bool>(
            get: { stored ?? defaultExpanded },
            set: { UserDefaults.standard.set($0, forKey: key) }
        )
        ProjectAccordionRow(
            project: project,
            sessions: sessions,
            isExpanded: isExpandedBinding
        )
    }

    /// Match accordion sessions to the project. The aggregate's `id` is
    /// keyed on project name today (`ProjectAggregate.id == name`), and
    /// the session's `project` field carries the project name too — so
    /// straight name-equality is the join key. Fallback to projectId if
    /// both are non-nil.
    private func sessionsFor(_ project: ProjectAggregate) -> [Session] {
        sessionObserver.activeSessions.filter { session in
            if let pid = session.projectId, let aid = project.projectID, pid == aid {
                return true
            }
            return session.project == project.name
        }
    }

    // MARK: - @AppStorage namespacing + pruning

    /// Stable namespaced key for an accordion row's expand state.
    /// Prefix-grepping for `expandKeyPrefix` is the cleanup contract
    /// the pruning helper relies on; do NOT change without also
    /// updating `pruneOrphanExpandKeys`.
    static let expandKeyPrefix = "projects-accordion-expanded."

    static func expandKey(for id: String) -> String {
        expandKeyPrefix + id
    }

    /// Drop UserDefaults entries for projects that no longer exist in the
    /// registry. O(N) over all defaults — fine because the projects-
    /// accordion namespace is bounded and the call runs once per
    /// `ProjectsView.task()`. Exposed `static` so tests can drive it.
    static func pruneOrphanExpandKeys(liveIds: Set<String>) {
        let defaults = UserDefaults.standard
        let allKeys = defaults.dictionaryRepresentation().keys
        for key in allKeys where key.hasPrefix(expandKeyPrefix) {
            let id = String(key.dropFirst(expandKeyPrefix.count))
            if !liveIds.contains(id) {
                defaults.removeObject(forKey: key)
            }
        }
    }
}

@MainActor
final class ProjectsViewModel: ObservableObject {
    @Published private(set) var projects: [ProjectAggregate] = []
    @Published private(set) var isLoading: Bool = false

    private let client = NexusShared.NexusAggregateClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        // Merged across all reachable agents; partial failure tolerated.
        let rows = await client.fetchProjects()
        projects = rows.sorted { lhs, rhs in
            if lhs.activeSessions != rhs.activeSessions {
                return lhs.activeSessions > rhs.activeSessions
            }
            return lhs.name < rhs.name
        }
    }

    /// Remove (hide) a discovered project: optimistically drop the row, fire
    /// `PATCH /projects/:id { hidden: true }` with the row's registry UUID,
    /// then refresh so the server's hidden-filtered list is authoritative (and
    /// the row reappears if the patch was rejected upstream).
    ///
    /// No-op when the row has no registry id (session-only bucket) — the UI
    /// already hides the affordance for those, this is the defensive guard.
    func remove(_ project: ProjectAggregate) async {
        guard let projectID = project.projectID else { return }
        projects.removeAll { $0.id == project.id }
        await client.patchProject(id: projectID, hidden: true)
        await load()
    }
}
