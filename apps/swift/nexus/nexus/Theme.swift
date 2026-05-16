//
//  Theme.swift
//  nexus
//
//  Wireframe-locked color tokens (docs/wireframes/nexus-menubar/styles.css).
//  All views address colors via `Color.nx.<token>` rather than literals.
//

import SwiftUI

extension Color {
    /// Namespace handle so call sites read `Color.nx.phosphor`, matching the
    /// CSS `--phosphor` token name used in the wireframe.
    static let nx = NxPalette()
}

struct NxPalette {
    // Substrate / surface
    let substrate    = Color(hex: 0x0A0B0D)
    let substrate2   = Color(hex: 0x0F1114)
    let substrate3   = Color(hex: 0x15181C)

    // Lines
    let hairline       = Color(hex: 0x1F2225)
    let hairlineStrong = Color(hex: 0x2A2E33)

    // Ink scale (text)
    let ink  = Color(hex: 0xE6E8EA)
    let ink2 = Color(hex: 0xA8AEB5)
    let ink3 = Color(hex: 0x7A8088)
    let ink4 = Color(hex: 0x4B5158)

    // Brand + state
    let phosphor     = Color(hex: 0x52FF8C)
    let phosphorDim  = Color(hex: 0x2BA85C)
    let amber        = Color(hex: 0xFFB547)
    let amberDim     = Color(hex: 0x8C5F1F)
    let critical     = Color(hex: 0xFF5470)
    let criticalDim  = Color(hex: 0x80293A)
}

extension Color {
    /// 0xRRGGBB hex initializer.
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8)  & 0xFF) / 255
        let b = Double( hex        & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

/// Standard gradient fills used by Sparkline + IdentityRow.
enum NxGradient {
    static let phosphor = LinearGradient(
        colors: [Color.nx.phosphor.opacity(0.30), Color.nx.phosphor.opacity(0.0)],
        startPoint: .top, endPoint: .bottom
    )
    static let muted = LinearGradient(
        colors: [Color.nx.ink3.opacity(0.18), Color.nx.ink3.opacity(0.0)],
        startPoint: .top, endPoint: .bottom
    )
    static let identityAvatar = LinearGradient(
        colors: [Color.nx.phosphor, Color.nx.phosphorDim],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
}
