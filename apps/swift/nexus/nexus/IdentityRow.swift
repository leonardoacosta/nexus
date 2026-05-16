//
//  IdentityRow.swift
//  nexus
//
//  Top panel region: avatar gradient + homelab name + heartbeat-delta status
//  sub-line + trailing `⋯` chevron that opens Preferences.
//

import SwiftUI

struct IdentityRow: View {
    @EnvironmentObject private var vm: NexusViewModel

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            // Avatar
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(NxGradient.identityAvatar)
                    .frame(width: 28, height: 28)
                Text("H")
                    .font(.jbm(13, weight: .bold))
                    .foregroundStyle(Color.nx.substrate)
            }
            .shadow(color: Color.nx.phosphor.opacity(0.25), radius: 6)

            // Name + status sub-line
            VStack(alignment: .leading, spacing: 2) {
                Text("homelab")
                    .font(.jbm(13, weight: .semibold))
                    .foregroundStyle(Color.nx.ink)
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusIndicatorColor)
                        .frame(width: 5, height: 5)
                        .shadow(color: statusIndicatorColor.opacity(0.6), radius: 4)
                    Text(statusSubline.uppercased())
                        .font(.jbm(9))
                        .tracking(0.8)
                        .foregroundStyle(Color.nx.ink3)
                }
            }

            Spacer(minLength: 0)

            // Preferences `⋯` chevron
            Button(action: openPreferences) {
                Image(systemName: "ellipsis")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .background(
                        RoundedRectangle(cornerRadius: 5).stroke(Color.nx.hairline, lineWidth: 1)
                    )
                    .foregroundStyle(Color.nx.ink3)
            }
            .buttonStyle(.plain)
            .help("Preferences (⌘,)")
            .accessibilityLabel("Open Preferences")
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .background(
            Rectangle().fill(Color.clear).overlay(
                Rectangle()
                    .fill(Color.nx.hairline)
                    .frame(height: 1),
                alignment: .bottom
            )
        )
    }

    private var statusIndicatorColor: Color {
        switch vm.aggregateState {
        case .active:      return Color.nx.phosphor
        case .idle:        return Color.nx.ink3
        case .stale:       return Color.nx.amber
        case .unreachable: return Color.nx.critical
        }
    }

    private var statusSubline: String {
        let count = vm.homelabSessions.count
        let countLabel = count == 1 ? "1 session" : "\(count) sessions"
        switch vm.aggregateState {
        case .active:      return "\(countLabel) · last beat \(humanDelta)"
        case .idle:        return "idle · last beat \(humanDelta)"
        case .stale:       return "stale · \(humanDelta)"
        case .unreachable: return "unreachable"
        }
    }

    private var humanDelta: String {
        guard let hb = vm.lastHeartbeat else { return "—" }
        let secs = Int(Date().timeIntervalSince(hb))
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m" }
        return "\(secs / 3600)h"
    }

    private func openPreferences() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }
}
