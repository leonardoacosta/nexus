// RoadmapView — capability roadmap surface for the nexus-mac dashboard.
//
// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.5)
//
// A `List` of `[CAPABILITY]` epics (fetched via `GET /roadmap?project=`),
// each rendered as a `DisclosureGroup` of its child proposals. Every
// capability carries an aggregate progress bar (`progress.closedTasks /
// progress.totalTasks`); every proposal carries its own per-proposal bar
// (`rollup.tasks.closed / rollup.tasks.total`) plus a ready-count chip and
// tappable epic/feature bead ids (reusing the shared bead chips from
// BeadStatusGlyph.swift).
//
// Loading / empty / error states mirror HealthView's pattern — the
// `/roadmap` endpoint 404s on older agents, so the aggregate client already
// degrades those to `[]` and the view surfaces a graceful empty state.

import SwiftUI
import NexusShared

struct RoadmapView: View {
    @StateObject private var model = RoadmapViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            content
        }
        .padding(.vertical, 8)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private var header: some View {
        HStack {
            Text("ROADMAP")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Spacer()
            if !model.capabilities.isEmpty {
                Text("\(model.capabilities.count) capabilities")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
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

    @ViewBuilder
    private var content: some View {
        if model.capabilities.isEmpty {
            ContentUnavailableView(
                "No roadmap yet",
                systemImage: "map",
                description: Text(
                    model.isLoading
                        ? "Loading…"
                        : "No [CAPABILITY] epics with linked proposals were found. The agent's /roadmap endpoint returns capabilities once feature beads carry a spec_id."
                )
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                ForEach(model.capabilities) { capability in
                    CapabilityDisclosure(capability: capability)
                }
            }
            .listStyle(.inset)
        }
    }
}

/// One `[CAPABILITY]` row: a `DisclosureGroup` whose label carries the
/// capability name + aggregate bar and whose body lists each proposal.
private struct CapabilityDisclosure: View {
    let capability: RoadmapCapability
    @State private var expanded: Bool = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(capability.proposals) { proposal in
                RoadmapProposalRow(proposal: proposal)
                    .padding(.vertical, 2)
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(capability.name)
                        .font(.system(.body, design: .monospaced))
                    Text(capability.epicId)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                    Text("\(capability.progress.closedTasks)/\(capability.progress.totalTasks)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: capability.progress.fraction)
                    .progressViewStyle(.linear)
                    .tint(.green)
            }
            .accessibilityIdentifier("roadmap-capability-\(capability.name)")
        }
    }
}

/// One proposal under a capability: slug + spec-status glyph, a per-proposal
/// progress bar, ready chip, and tappable epic/feature bead ids.
private struct RoadmapProposalRow: View {
    let proposal: RoadmapProposal

    private var rollup: BeadRollup { proposal.rollup }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                specStatusBadge
                Text(proposal.slug)
                    .font(.caption.monospaced())
                Spacer(minLength: 0)
                Text("\(rollup.tasks.closed)/\(rollup.tasks.total)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                ProgressView(value: rollup.progress)
                    .progressViewStyle(.linear)
                    .frame(maxWidth: 160)
                if rollup.tasks.ready > 0 {
                    ReadyCountChip(count: rollup.tasks.ready)
                }
                if let epic = rollup.epic {
                    BeadIdChip(ref: epic, role: "epic")
                }
                if let feature = rollup.feature {
                    BeadIdChip(ref: feature, role: "feature")
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityIdentifier("roadmap-proposal-\(proposal.slug)")
    }

    /// spec-status dot: green = active, gray = archived, red = missing.
    private var specStatusBadge: some View {
        let color: Color = {
            switch proposal.specStatus.lowercased() {
            case "active":   return .green
            case "archived": return .gray
            case "missing":  return .red
            default:         return .secondary
            }
        }()
        return Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .help("spec: \(proposal.specStatus)")
    }
}

@MainActor
final class RoadmapViewModel: ObservableObject {
    @Published private(set) var capabilities: [RoadmapCapability] = []
    @Published private(set) var isLoading: Bool = false

    private let client = NexusShared.NexusAggregateClient()

    /// Fetch the roadmap for every known project and flatten the
    /// capabilities into one list (deduped by epicId; capability names are
    /// globally unique in practice). A project lives on one agent, so the
    /// aggregate client's fan-out is a "which agent owns this" probe.
    func load() async {
        isLoading = true
        defer { isLoading = false }
        let projects = await client.fetchProjects()
        // Fall back to the fleet default project when no registry rows exist
        // (e.g. single-agent localhost with an empty projects list) so the
        // Roadmap tab still probes `nx`.
        let codes = projects.isEmpty ? ["nx"] : projects.map(\.id)
        var merged: [String: RoadmapCapability] = [:]
        await withTaskGroup(of: [RoadmapCapability].self) { group in
            for code in Set(codes) {
                group.addTask { [client] in
                    await client.fetchRoadmap(project: code)
                }
            }
            for await caps in group {
                for c in caps { merged[c.epicId] = c }
            }
        }
        self.capabilities = merged.values.sorted { $0.name < $1.name }
    }
}

#if DEBUG
#Preview("Roadmap · mock") {
    // Representative mock payload so the view renders without a live agent
    // (the /roadmap endpoint may 404 until the agent aggregator ships).
    let rollupA = BeadRollup(
        epic: BeadRef(id: "nx-0bhyl", status: "in_progress", type: "epic", priority: 2, title: "[CAPABILITY] specs surface"),
        feature: BeadRef(id: "nx-naeby", status: "in_progress", type: "feature", priority: 2, title: "bead <-> proposal roadmap"),
        tasks: BeadTaskCounts(total: 14, closed: 9, ready: 3, blocked: 1),
        beads: [
            BeadRef(id: "nx-iqekj", status: "closed", type: "task", priority: 2, title: "Swift models"),
            BeadRef(id: "nx-2n3ka", status: "open", type: "task", priority: 2, title: "Roadmap tab"),
        ]
    )
    let rollupB = BeadRollup(
        epic: BeadRef(id: "nx-abcde", status: "open", type: "epic", priority: 2, title: "[CAPABILITY] health"),
        feature: BeadRef(id: "nx-fghij", status: "open", type: "feature", priority: 3, title: "process view"),
        tasks: BeadTaskCounts(total: 6, closed: 6, ready: 0, blocked: 0),
        beads: []
    )
    let caps = [
        RoadmapCapability(
            name: "specs-surface",
            epicId: "nx-0bhyl",
            epicStatus: "in_progress",
            proposals: [
                RoadmapProposal(slug: "add-bead-proposal-roadmap-surface", rollup: rollupA, specStatus: "active"),
            ],
            progress: RoadmapProgress(totalTasks: 14, closedTasks: 9)
        ),
        RoadmapCapability(
            name: "health",
            epicId: "nx-abcde",
            epicStatus: "open",
            proposals: [
                RoadmapProposal(slug: "health-tab-process-view", rollup: rollupB, specStatus: "archived"),
            ],
            progress: RoadmapProgress(totalTasks: 6, closedTasks: 6)
        ),
    ]
    return List {
        ForEach(caps) { CapabilityDisclosure(capability: $0) }
    }
    .frame(width: 520, height: 360)
}
#endif
