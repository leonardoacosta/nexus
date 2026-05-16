//
//  SessionRow.swift
//  nexus
//
//  14-pt project sigil + title + meta line + right-aligned age delta. Active
//  sessions get a phosphor-filled sigil with glow.
//

import SwiftUI

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
        let model   = session.model.map { "\($0)" } ?? "claude"
        return "\(project) · \(model)"
    }

    private var ageString: String {
        let secs = Int(Date().timeIntervalSince(session.startedAt))
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m" }
        if secs < 86400 { return "\(secs / 3600)h" }
        return "\(secs / 86400)d"
    }

    @ViewBuilder
    private var sigil: some View {
        let initial = String((session.project ?? "?").prefix(1)).uppercased()
        let active  = session.status == "active"
        ZStack {
            RoundedRectangle(cornerRadius: 3)
                .stroke(active ? Color.nx.phosphor : Color.nx.hairlineStrong, lineWidth: 1)
                .background(
                    RoundedRectangle(cornerRadius: 3)
                        .fill(active ? Color.nx.phosphor : Color.clear)
                )
                .frame(width: 14, height: 14)
            Text(initial)
                .font(.jbm(10, weight: .bold))
                .foregroundStyle(active ? Color.nx.substrate : Color.nx.ink3)
        }
        .shadow(color: active ? Color.nx.phosphor.opacity(0.4) : .clear, radius: 4)
    }
}
