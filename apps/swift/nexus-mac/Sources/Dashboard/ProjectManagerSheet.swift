// ProjectManagerSheet — show/hide registered projects on the board rail.
//
// Every git repo under the scanned dir is auto-upserted into the registry by
// the agent's background discovery scan, so there is NO "create project"
// action: this sheet lists every discovered `ProjectAggregate` (hidden AND
// visible) and lets each be toggled. Flipping a row ON un-hides it (which IS
// "registering" it onto the rail); OFF hides it. Drives the already-wired
// `patchProject(id:hidden:)` fan-out.

import SwiftUI
import NexusShared

struct ProjectManagerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = ProjectManagerModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Projects")
                    .font(Font.nx.serifTitle(18))
                    .foregroundStyle(Color.nx.ink)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(16)
            Divider().overlay(Color.nx.hairline)

            if model.isLoading && model.projects.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(40)
            } else if model.projects.isEmpty {
                ContentUnavailableView(
                    "No projects",
                    systemImage: "folder",
                    description: Text("No registered projects were discovered across the fleet.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.projects) { p in
                            row(p)
                            Divider().overlay(Color.nx.hairline)
                        }
                    }
                }
            }
        }
        .frame(width: 420, height: 520)
        .background(.thickMaterial)
        .task { await model.load() }
        .accessibilityIdentifier("project-manager-sheet")
    }

    private func row(_ p: ProjectAggregate) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name)
                    .font(Font.nx.code(12, weight: .medium))
                    .foregroundStyle(Color.nx.ink)
                    .lineLimit(1).truncationMode(.middle)
                Text("\(p.activeSessions) active · \(p.totalSessions) total")
                    .font(Font.nx.ui(10))
                    .foregroundStyle(Color.nx.ink4)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: Binding(
                get: { !p.hidden },
                set: { model.setShown(p, shown: $0) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .tint(Color.accentColor)
            .accessibilityIdentifier("project-manager-toggle-\(p.name)")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

@MainActor
final class ProjectManagerModel: ObservableObject {
    @Published private(set) var projects: [ProjectAggregate] = []
    @Published private(set) var isLoading = false

    private let client = NexusShared.NexusAggregateClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        let all = await client.fetchProjects()
        projects = all.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// Toggle a project's visibility. Optimistic local update + fire-and-forget
    /// patch fan-out (the aggregate client applies it on the owning agent, the
    /// rest 404 harmlessly).
    func setShown(_ p: ProjectAggregate, shown: Bool) {
        let hidden = !shown
        if let i = projects.firstIndex(where: { $0.id == p.id }) {
            projects[i].hidden = hidden
        }
        // The PATCH /projects/:id endpoint validates against the registry id
        // (the `projectID` UUID); fall back to the name only when an older
        // agent omitted it. See deviation note in the redesign report.
        let patchID = p.projectID ?? p.id
        Task { await client.patchProject(id: patchID, hidden: hidden) }
    }
}
