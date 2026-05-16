//
//  SessionList.swift
//  nexus
//
//  Filters `viewModel.sessions` to homelab-origin sessions and renders one
//  `SessionRow` per. Empty state surfaces the ⌃⌥H spawn hint per spec
//  scenario "Empty list invites spawn".
//

import SwiftUI

struct SessionList: View {
    @EnvironmentObject private var vm: NexusViewModel
    @State private var focusedIndex: Int = 0
    @FocusState private var focusedSessionID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if vm.homelabSessions.isEmpty {
                emptyState
            } else {
                listBody
            }
        }
        .padding(.vertical, 6)
    }

    private var header: some View {
        HStack {
            Text("REMOTE SESSIONS")
                .font(.jbm(9))
                .tracking(2.2)
                .foregroundStyle(Color.nx.ink4)
            Spacer()
            Text("\(vm.homelabSessions.count) LIVE")
                .font(.jbm(9))
                .tracking(0.6)
                .foregroundStyle(Color.nx.phosphor)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.nx.phosphor.opacity(0.08))
                        .overlay(
                            RoundedRectangle(cornerRadius: 2)
                                .stroke(Color.nx.phosphor.opacity(0.18), lineWidth: 1)
                        )
                )
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var listBody: some View {
        VStack(spacing: 0) {
            ForEach(vm.homelabSessions) { session in
                SessionRow(session: session,
                           isSelected: session.id == vm.selectedSessionId)
                    .contentShape(Rectangle())
                    .onTapGesture { vm.selectSession(id: session.id) }
                    .focusable(true)
                    .focused($focusedSessionID, equals: session.id)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)),
                        removal: .opacity
                    ))
            }
        }
        .animation(.easeInOut(duration: 0.16), value: vm.homelabSessions.map(\.id))
        .onAppear {
            if focusedSessionID == nil {
                focusedSessionID = vm.selectedSessionId ?? vm.homelabSessions.first?.id
            }
        }
        .onChange(of: focusedSessionID) { _, new in
            if let new { vm.selectSession(id: new) }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .center, spacing: 6) {
            Text("· · ·")
                .font(.jbm(18))
                .tracking(3)
                .foregroundStyle(Color.nx.ink4)
            Text("no claude code on homelab")
                .font(.jbm(11))
                .foregroundStyle(Color.nx.ink3)
            Text("⌃⌥H spawns a session there")
                .font(.jbm(10))
                .foregroundStyle(Color.nx.ink4)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }
}
