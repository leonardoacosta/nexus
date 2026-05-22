//
//  IdentityRow.swift
//  nexus
//
//  Top panel region: avatar gradient + homelab name + heartbeat-delta status
//  sub-line + trailing `⋯` Menu dropdown with Nexus actions (open dashboard,
//  preferences, quit). The Menu replaced a Button whose `showSettingsWindow:`
//  selector no longer dispatches reliably to the modern `Settings { ... }`
//  scene (bd:nx-2pmzs).
//

import SwiftUI
import AppKit

struct IdentityRow: View {
    @EnvironmentObject private var vm: NexusViewModel
    @Environment(\.openWindow) private var openWindow

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

            // Nexus actions `⋯` Menu — opens dashboard, preferences, or
            // quits. Replaces a Button whose legacy `showSettingsWindow:`
            // selector no longer dispatches to the modern `Settings { }`
            // scene reliably (bd:nx-2pmzs). `SettingsLink` is the
            // SwiftUI-native replacement (macOS 14+, matches project.yml
            // minimum deployment target).
            Menu {
                Button("Open Dashboard Window") {
                    openWindow(id: "dashboard")
                }
                SettingsLink {
                    Text("Preferences…")
                }
                Divider()
                Button("Quit Nexus") {
                    NSApplication.shared.terminate(nil)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .background(
                        RoundedRectangle(cornerRadius: 5).stroke(Color.nx.hairline, lineWidth: 1)
                    )
                    .foregroundStyle(Color.nx.ink3)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 24, height: 24)
            .help("Nexus actions")
            .accessibilityLabel("Nexus actions menu")
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

}
