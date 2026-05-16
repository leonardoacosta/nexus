//
//  ActionRow.swift
//  nexus
//
//  3-column grid hosting ATTACH / NOTIFY / TTS at the bottom of the panel.
//  Each button owns its own popover state.
//

import SwiftUI

struct ActionRow: View {
    @EnvironmentObject private var vm: NexusViewModel

    var body: some View {
        HStack(spacing: 0) {
            AttachButton().overlay(divider, alignment: .trailing)
            NotifyButton().overlay(divider, alignment: .trailing)
            TtsButton()
        }
        .frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.18))
        .overlay(
            Rectangle().fill(Color.nx.hairline).frame(height: 1),
            alignment: .top
        )
    }

    private var divider: some View {
        Rectangle().fill(Color.nx.hairline).frame(width: 1)
    }
}

// MARK: - Shared style

struct ActionButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color.clear)
            .contentShape(Rectangle())
    }
}
