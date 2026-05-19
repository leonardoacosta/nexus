// ProjectsView — macOS dashboard parity for apps/nextjs/src/app/projects.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.4)
//
// Read-only view: project name, active/total session counts, and the
// set of machines hosting at least one session. Refresh-on-foreground +
// pull-down (Cmd+R) — no SSE topic for project rollup today.

import SwiftUI
import NexusShared

struct ProjectsView: View {
    @StateObject private var model = ProjectsViewModel()

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
                    ProjectRow(project: project)
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
}

private struct ProjectRow: View {
    let project: ProjectAggregate

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text(project.name)
                    .font(.system(.body, design: .monospaced))
                machines
            }
            Spacer()
            counts
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private var machines: some View {
        HStack(spacing: 4) {
            Image(systemName: "server.rack")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text(project.machines.isEmpty ? "—" : project.machines.joined(separator: ", "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    private var counts: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 4) {
                Circle()
                    .fill(project.activeSessions > 0 ? Color.green : Color.secondary)
                    .frame(width: 7, height: 7)
                Text("\(project.activeSessions) active")
                    .font(.caption.monospacedDigit())
            }
            Text("\(project.totalSessions) total")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
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
