//
//  Sparkline.swift
//  nexus
//
//  Reusable polyline + gradient-fill chart for CPU / RAM sparklines. Renders
//  a fixed 120×32 viewbox via SwiftUI `Canvas`. Honors `isStale` by dropping
//  to 40% opacity + overlaying a `STALE mm:ss` label per spec.
//

import SwiftUI

struct Sparkline: View {
    var values: [Double]
    var stroke: Color
    var fill: LinearGradient
    var isStale: Bool
    var staleLabel: String

    var body: some View {
        ZStack {
            GeometryReader { geo in
                Canvas { ctx, size in
                    guard values.count >= 2 else { return }
                    let yMax: Double = max(values.max() ?? 100, 100)
                    let yMin: Double = 0
                    let span = max(yMax - yMin, 1)
                    let step = size.width / CGFloat(values.count - 1)
                    var line = Path()
                    var area = Path()
                    area.move(to: CGPoint(x: 0, y: size.height))
                    for (i, v) in values.enumerated() {
                        let x = CGFloat(i) * step
                        let norm = (v - yMin) / span
                        let y = size.height - CGFloat(norm) * size.height
                        let pt = CGPoint(x: x, y: y)
                        if i == 0 { line.move(to: pt) } else { line.addLine(to: pt) }
                        area.addLine(to: pt)
                    }
                    area.addLine(to: CGPoint(x: size.width, y: size.height))
                    area.closeSubpath()
                    ctx.fill(area, with: .style(fill))
                    ctx.stroke(line, with: .color(stroke), style: StrokeStyle(lineWidth: 1.25, lineJoin: .round))
                    // Endpoint dot
                    if let last = values.last {
                        let x = size.width
                        let norm = (last - yMin) / span
                        let y = size.height - CGFloat(norm) * size.height
                        let dotRect = CGRect(x: x - 2.5, y: y - 2.5, width: 5, height: 5)
                        ctx.fill(Path(ellipseIn: dotRect), with: .color(stroke))
                        ctx.fill(Path(ellipseIn: dotRect.insetBy(dx: 1, dy: 1)),
                                 with: .color(.white.opacity(0.9)))
                    }
                }
                .opacity(isStale ? 0.4 : 1.0)
                .frame(width: geo.size.width, height: geo.size.height)
            }
            if isStale {
                Text(staleLabel)
                    .font(.jbm(9))
                    .tracking(2)
                    .foregroundStyle(Color.nx.critical)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.nx.substrate.opacity(0.78))
            }
        }
        .frame(height: 32)
    }
}
