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
        Canvas { ctx, size in
            let barH = size.height * 0.18
            let gap  = size.height * 0.10
            let totalH = barH * 3 + gap * 2
            let originY = (size.height - totalH) / 2
            let widths: [CGFloat] = [size.width, size.width * 0.78, size.width * 0.56]
            let color = barColor(for: state)
            for i in 0..<3 {
                let y = originY + CGFloat(i) * (barH + gap)
                let rect = CGRect(x: 0, y: y, width: widths[i], height: barH)
                let path = Path(roundedRect: rect, cornerRadius: barH / 2)
                ctx.fill(path, with: .color(color))
            }
        }
        .frame(width: 18, height: 18)
        .overlay {
            if ttsMuted {
                Canvas { ctx, size in
                    var p = Path()
                    p.move(to: CGPoint(x: 0, y: size.height))
                    p.addLine(to: CGPoint(x: size.width, y: 0))
                    // Outline for contrast against the dark menu bar.
                    ctx.stroke(p, with: .color(Color.nx.substrate.opacity(0.9)), lineWidth: 2.5)
                    ctx.stroke(p, with: .color(Color.nx.critical), lineWidth: 1.5)
                }
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
