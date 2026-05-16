//
//  NotifyButton.swift
//  nexus
//
//  Bell glyph with pulse-on-unread + popover history (50-entry ring buffer).
//  Click a row to replay; click CLEAR to wipe history.
//

import SwiftUI

struct NotifyButton: View {
    @EnvironmentObject private var vm: NexusViewModel
    @State private var showPopover = false
    @State private var seenCount = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var unread: Bool {
        vm.notifications.count > seenCount && !showPopover
    }

    var body: some View {
        Button {
            showPopover.toggle()
            if showPopover { seenCount = vm.notifications.count }
        } label: {
            VStack(spacing: 4) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bell")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.nx.ink2)
                    if unread {
                        Circle()
                            .fill(Color.nx.phosphor)
                            .frame(width: 6, height: 6)
                            .shadow(color: Color.nx.phosphor.opacity(0.8), radius: 4)
                            .offset(x: 4, y: -2)
                            .opacity(reduceMotion ? 1 : 0.85)
                            .scaleEffect(reduceMotion ? 1 : 1.0)
                            .animation(
                                reduceMotion
                                    ? .default
                                    : .easeInOut(duration: 1).repeatForever(autoreverses: true),
                                value: unread
                            )
                    }
                }
                Text("NOTIFY")
                    .font(.jbm(9, weight: .medium))
                    .tracking(1.4)
                    .foregroundStyle(Color.nx.ink3)
            }
        }
        .buttonStyle(.plain)
        .modifier(ActionButtonStyle())
        .popover(isPresented: $showPopover, arrowEdge: .top) {
            NotifyPopover().environmentObject(vm)
        }
    }
}

struct NotifyPopover: View {
    @EnvironmentObject private var vm: NexusViewModel
    @State private var flashId: UUID?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("HISTORY")
                    .font(.jbm(9))
                    .tracking(2)
                    .foregroundStyle(Color.nx.ink4)
                Spacer()
                Button("CLEAR") {
                    Task { await vm.clearNotifications() }
                }
                .buttonStyle(.plain)
                .font(.jbm(9, weight: .semibold))
                .foregroundStyle(Color.nx.phosphor)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(Rectangle().fill(Color.nx.hairline).frame(height: 1), alignment: .bottom)

            if vm.notifications.isEmpty {
                Text("no notifications yet")
                    .font(.jbm(11))
                    .foregroundStyle(Color.nx.ink3)
                    .padding(24)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(vm.notifications) { ev in
                            row(for: ev)
                                .overlay(Rectangle().fill(Color.nx.hairline).frame(height: 1), alignment: .bottom)
                        }
                    }
                }
                .frame(maxHeight: 260)
            }
        }
        .frame(width: 320)
        .background(Color.nx.substrate3)
    }

    @ViewBuilder
    private func row(for ev: NotificationEvent) -> some View {
        Button {
            flashId = ev.id
            Task {
                await vm.replayNotification(ev)
                try? await Task.sleep(nanoseconds: 200_000_000)
                flashId = nil
            }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(ev.body)
                    .font(.jbm(11))
                    .foregroundStyle(Color.nx.ink)
                    .multilineTextAlignment(.leading)
                    .lineLimit(3)
                HStack(spacing: 8) {
                    if let c = ev.channel { Text(c.uppercased()) }
                    Text(timeAgo(ev.receivedAt))
                }
                .font(.jbm(9))
                .tracking(0.6)
                .foregroundStyle(Color.nx.ink4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(flashId == ev.id ? Color.nx.phosphor.opacity(0.18) : Color.clear)
        }
        .buttonStyle(.plain)
    }

    private func timeAgo(_ d: Date) -> String {
        let s = Int(Date().timeIntervalSince(d))
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86400 { return "\(s / 3600)h ago" }
        return "\(s / 86400)d ago"
    }
}
