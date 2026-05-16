//
//  StatusIcon.swift
//  nexus
//
//  22-pt menu bar glyph — three stacked horizontal bars rendered via SwiftUI
//  `Canvas`. Fill color encodes the aggregate state. The TTS-mute overlay is
//  a diagonal slash composed on top via `.overlay`.
//

import SwiftUI

struct StatusIcon: View {
    var state: AggregateState
    var ttsMuted: Bool

    var body: some View {
        // SF Symbol "chart.bar.fill" with palette rendering — the 3-bar shape
        // we want, but driven by Apple's symbol pipeline so macOS doesn't
        // template-flatten our Canvas into invisibility on the menu bar slot.
        // Explicit `.foregroundStyle` survives menu bar tinting.
        Image(systemName: "chart.bar.fill")
            .symbolRenderingMode(.palette)
            .foregroundStyle(
                barColor(for: state),
                barColor(for: state).opacity(0.78),
                barColor(for: state).opacity(0.56)
            )
            .font(.system(size: 14, weight: .semibold))
            .overlay(alignment: .center) {
                if ttsMuted {
                    Image(systemName: "line.diagonal")
                        .font(.system(size: 18, weight: .heavy))
                        .foregroundStyle(Color.nx.critical)
                        .rotationEffect(.degrees(-90))
                }
            }
            .accessibilityLabel(state.accessibilityLabel + (ttsMuted ? ", TTS muted" : ""))
    }

    private func barColor(for state: AggregateState) -> Color {
        switch state {
        case .active:      return Color.nx.phosphor
        case .idle:        return Color.nx.ink2
        case .stale:       return Color.nx.amber
        case .unreachable: return Color.nx.critical
        }
    }
}

#if DEBUG
struct StatusIcon_Previews: PreviewProvider {
    static var previews: some View {
        HStack(spacing: 20) {
            StatusIcon(state: .active, ttsMuted: false)
            StatusIcon(state: .idle, ttsMuted: false)
            StatusIcon(state: .stale, ttsMuted: false)
            StatusIcon(state: .unreachable, ttsMuted: false)
            StatusIcon(state: .active, ttsMuted: true)
        }
        .padding()
        .background(Color.nx.substrate)
    }
}
#endif
