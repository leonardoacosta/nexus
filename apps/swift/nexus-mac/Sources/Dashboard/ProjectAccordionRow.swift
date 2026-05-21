// ProjectAccordionRow — expandable Projects-tab row with git metadata
// and a nested live-session list.
//
// Spec: openspec/changes/projects-tab-accordion-deeplink (task 2.4)
//
// Collapsed:
//   <name>     <session-count>   [branch chip]
// Expanded adds:
//   - git metadata pane (ahead/behind/dirty/last-commit)
//   - nested session list (rows tap-to-deep-link into Sessions tab)
//
// Branch chip palette:
//   - green       → branch present, dirty == false
//   - orange `*`  → branch present, dirty == true
//   - gray mono   → "(detached)" for branch == nil
//   - hidden      → gitMetadata == nil (non-git project)
//
// The accordion uses SwiftUI's `DisclosureGroup` for the expand affordance;
// the parent `ProjectsView` owns the `@AppStorage` binding so user
// overrides survive launches.

import SwiftUI
import NexusShared

struct ProjectAccordionRow: View {
    let project: ProjectAggregate
    /// Live sessions for this project — supplied by the parent so all
    /// accordion rows share a single observer.
    let sessions: [Session]
    @Binding var isExpanded: Bool
    @EnvironmentObject private var coordinator: DashboardNavigationCoordinator

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            expandedContent
        } label: {
            collapsedHeader
        }
        .disclosureGroupStyle(.automatic)
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .accessibilityIdentifier("project-accordion-\(project.id)")
    }

    // MARK: - Collapsed header

    private var collapsedHeader: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(project.name)
                .font(.system(.body, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
            branchChip
            Spacer()
            counts
        }
    }

    @ViewBuilder
    private var branchChip: some View {
        if let md = project.gitMetadata {
            if let branch = md.branch {
                let chipText = md.dirty ? "\(branch)*" : branch
                Text(chipText)
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        (md.dirty ? Color.orange : Color.green).opacity(0.15)
                    )
                    .foregroundStyle(md.dirty ? Color.orange : Color.green)
                    .clipShape(Capsule())
                    .accessibilityIdentifier("project-branch-chip-\(project.id)")
            } else {
                Text("(detached)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(Capsule())
                    .accessibilityIdentifier("project-branch-chip-\(project.id)")
            }
        }
        // gitMetadata == nil → no chip.
    }

    private var counts: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(project.activeSessions > 0 ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            Text("\(project.activeSessions) active")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Expanded content

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            gitMetadataPane
            if sessions.isEmpty {
                Text("no live sessions")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 4)
            } else {
                ForEach(sessions) { session in
                    sessionRow(session)
                }
            }
        }
        .padding(.top, 4)
        .padding(.leading, 12)
    }

    @ViewBuilder
    private var gitMetadataPane: some View {
        if let md = project.gitMetadata {
            HStack(spacing: 10) {
                if md.branch != nil {
                    // Ahead/behind hidden for detached HEAD per spec.
                    Text("↑\(md.ahead) ↓\(md.behind)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                if md.dirty {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 6, height: 6)
                        .accessibilityLabel("dirty")
                }
                if let commit = md.lastCommit {
                    Text("\(commit.author) · \(Self.relative(commit.ts))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        } else {
            Text("(not a git repo)")
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: Session) -> some View {
        Button {
            coordinator.openSession(session.id)
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
                Text(Session.projectLabel(for: session))
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                if let branch = session.branch, !branch.isEmpty {
                    Text("·").foregroundStyle(.tertiary).font(.caption2)
                    Text(branch)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(session.status)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("project-session-row-\(session.id)")
    }

    // MARK: - Helpers

    /// Coarse `N(m|h|d) ago` formatter — good enough for the "leo · 2h
    /// ago" cell. Falls back to absolute date for >7d to avoid lying.
    static func relative(_ date: Date, now: Date = Date()) -> String {
        let interval = max(0, now.timeIntervalSince(date))
        let minute: TimeInterval = 60
        let hour = 60 * minute
        let day = 24 * hour
        if interval < minute { return "just now" }
        if interval < hour {
            return "\(Int(interval / minute))m ago"
        }
        if interval < day {
            return "\(Int(interval / hour))h ago"
        }
        if interval < 7 * day {
            return "\(Int(interval / day))d ago"
        }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .none
        return f.string(from: date)
    }
}
