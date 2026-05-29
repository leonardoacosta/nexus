//
//  SessionRow.swift
//  nexus
//
//  14-pt project sigil + title + meta line + right-aligned age delta. Active
//  sessions get a phosphor-filled sigil with glow.
//

import SwiftUI
import NexusShared

struct SessionRow: View {
    let session: NexusSession
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            sigil
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.jbm(12, weight: .medium))
                    .foregroundStyle(Color.nx.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(metaLine.uppercased())
                    .font(.jbm(9))
                    .tracking(0.8)
                    .foregroundStyle(Color.nx.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(ageString)
                .font(.jbm(10))
                .foregroundStyle(Color.nx.ink3)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(
            isSelected
                ? Color.nx.phosphor.opacity(0.06)
                : Color.clear
        )
        .overlay(
            Rectangle()
                .fill(isSelected ? Color.nx.phosphor : Color.clear)
                .frame(width: 2),
            alignment: .leading
        )
    }

    private var title: String {
        // Prefer branch or project as a friendly title hint.
        if let p = session.project, !p.isEmpty {
            if let b = session.branch, !b.isEmpty { return "\(p) · \(b)" }
            return p
        }
        return session.id.prefix(12).description
    }

    private var metaLine: String {
        let project = session.project ?? session.projectId ?? "—"
        return Self.subtitle(project: project, branch: session.branch)
    }

    private var ageString: String {
        let secs = Int(Date().timeIntervalSince(session.startedAt))
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m" }
        if secs < 86400 { return "\(secs / 3600)h" }
        return "\(secs / 86400)d"
    }

    // MARK: - Agent-state sigil tokens (nx-c9muh)

    /// Stable, value-comparable identity for each sigil tint. Kept distinct
    /// from `Color` so the decision logic is unit-testable: SwiftUI `Color`
    /// equality is unreliable across contexts, whereas this enum compares by
    /// case. `color` is the single place that binds a token to a palette entry
    /// — the view never re-derives the mapping. Spec: nx-mld93.
    enum SigilToken: Equatable {
        /// blocked — busy, working a tool.
        case phosphor
        /// waiting — needs user input / permission prompt.
        case amber
        /// ready — idle, awaiting the next prompt.
        case phosphorDim
        /// nil agentState — legacy / unknown, today's default look.
        case neutral

        var color: Color {
            switch self {
            case .phosphor:    return Color.nx.phosphor
            case .amber:       return Color.nx.amber
            case .phosphorDim: return Color.nx.phosphorDim
            case .neutral:     return Color.nx.hairlineStrong
            }
        }
    }

    /// Pure sigil decision: maps `agentState` to a (tint token, filled) pair.
    /// Drives the row's primary "can this agent take a command right now?"
    /// signal. Only the actively-working state gets the solid fill + glow;
    /// waiting/ready/neutral render as a hollow, colored outline so a row that
    /// can't take a command doesn't read as "live".
    /// - blocked  -> phosphor    (filled + glow)
    /// - waiting  -> amber       (hollow)
    /// - ready    -> phosphorDim (hollow)
    /// - nil      -> neutral hairline (hollow)
    static func sigilStyle(for state: AgentState?) -> (token: SigilToken, filled: Bool) {
        switch state {
        case .blocked: return (.phosphor, true)
        case .waiting: return (.amber, false)
        case .ready:   return (.phosphorDim, false)
        case .none:    return (.neutral, false)
        }
    }

    /// Pure subtitle decision: `project · branch` when a branch is present,
    /// `project` alone otherwise (nil or empty branch). The model name is
    /// intentionally dropped — it was identical on every row ("claude").
    /// Spec: openspec/changes/session-enrichment (task nx-c9muh).
    static func subtitle(project: String, branch: String?) -> String {
        if let branch, !branch.isEmpty {
            return "\(project) · \(branch)"
        }
        return project
    }

    @ViewBuilder
    private var sigil: some View {
        let initial = String((session.project ?? "?").prefix(1)).uppercased()
        let style   = Self.sigilStyle(for: session.agentState)
        let tint    = style.token.color
        let filled  = style.filled
        ZStack {
            RoundedRectangle(cornerRadius: 3)
                .stroke(tint, lineWidth: 1)
                .background(
                    RoundedRectangle(cornerRadius: 3)
                        .fill(filled ? tint : Color.clear)
                )
                .frame(width: 14, height: 14)
            Text(initial)
                .font(.jbm(10, weight: .bold))
                .foregroundStyle(filled ? Color.nx.substrate : Color.nx.ink3)
        }
        .shadow(color: filled ? tint.opacity(0.4) : .clear, radius: 4)
        .accessibilityLabel(accessibilityState)
    }

    /// VoiceOver string for the sigil — keeps the agent-state signal available
    /// to assistive tech now that the textual "active" label is gone.
    private var accessibilityState: String {
        switch session.agentState {
        case .blocked: return "Working"
        case .waiting: return "Waiting for input"
        case .ready:   return "Ready"
        case .none:    return "Unknown state"
        }
    }
}
