//
//  Theme.swift
//  nexus
//
//  Design foundation for the board shell. Aesthetic direction: refined native
//  macOS glass — the Apple Music / Podcasts / Settings register, not a bespoke
//  branded look. Two rules drive every token below:
//
//    1. No branded color. The former bespoke `phosphor` green is gone; every
//       selection / active / interactive-accent token now resolves to the
//       user's own system accent (`Color.accentColor`, respecting System
//       Settings > Appearance). The only two semantic status colors are
//       sourced from AppKit system colors so they stay dark-mode + a11y
//       correct.
//    2. No flat hex text/surface. Text tokens map to the semantic label
//       hierarchy and surfaces to AppKit's adaptive background colors, both of
//       which stay legible over blurred `Material` (chrome surfaces are built
//       directly from `.ultraThinMaterial` etc. at their call sites).
//
//  The token NAMES are retained as thin aliases so the whole `nexus-mac`
//  target (legacy `nexus/nexus/*` popover views + the board shell) keeps
//  addressing colors via `Color.nx.<token>` without a target-wide migration;
//  only their VALUES changed to the de-branded semantics above.
//

import SwiftUI

extension Color {
    /// Namespace handle so call sites read `Color.nx.accent`, `Color.nx.ink`.
    static let nx = NxPalette()
}

struct NxPalette {
    // Surface / substrate — AppKit adaptive backgrounds (auto dark/light).
    // Chrome (rail / ticker / board / rows / modal) is built from SwiftUI
    // `Material` at the call site; these remain for legacy popover views.
    let substrate    = Color(nsColor: .windowBackgroundColor)
    let substrate2   = Color(nsColor: .underPageBackgroundColor)
    let substrate3   = Color(nsColor: .controlBackgroundColor)

    // Hairlines — vibrancy-safe over any material.
    let hairline       = Color.primary.opacity(0.06)
    let hairlineStrong = Color.primary.opacity(0.12)

    // Text hierarchy — semantic label colors (legible over blurred material).
    let ink  = Color.primary
    let ink2 = Color.secondary
    let ink3 = Color(nsColor: .tertiaryLabelColor)
    let ink4 = Color(nsColor: .quaternaryLabelColor)

    // Interactive accent — the user's own system accent, never a brand color.
    // `phosphor` / `phosphorDim` are retained as aliases (legacy call sites)
    // that now resolve to the system accent.
    let accent       = Color.accentColor
    let phosphor     = Color.accentColor
    let phosphorDim  = Color.accentColor

    // Semantic status — AppKit system colors (dark-mode + a11y correct).
    let amber        = Color(nsColor: .systemOrange)
    let amberDim     = Color(nsColor: .systemOrange).opacity(0.55)
    let critical     = Color(nsColor: .systemRed)
    let criticalDim  = Color(nsColor: .systemRed).opacity(0.55)
}

extension Color {
    /// 0xRRGGBB hex initializer (retained for the few remaining literal-color
    /// call sites outside the palette).
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8)  & 0xFF) / 255
        let b = Double( hex        & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

// MARK: - Typography

extension Font {
    /// Namespaced type roles. `Font.nx.serifTitle` = New York (Apple's serif,
    /// the headline-over-glass treatment News/Podcasts use); `.ui` = SF Pro
    /// (Apple's UI font); `.code` = SF Mono for genuinely code-like tokens
    /// (bd IDs, project codes, tabular counters) ONLY.
    static let nx = NxTypography()
}

struct NxTypography {
    /// Headline / title role — New York serif over glass.
    func serifTitle(_ size: CGFloat = 20, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
    /// Body / UI chrome / labels — SF Pro (system default, NOT monospaced).
    func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    /// Code role — bd IDs, project codes, numeric counters needing tabular
    /// alignment. Monospaced is reserved for these tokens only.
    func code(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// Standard gradient fills used by Sparkline + IdentityRow. De-branded — the
/// former phosphor gradients now resolve to the system accent.
enum NxGradient {
    static let phosphor = LinearGradient(
        colors: [Color.accentColor.opacity(0.30), Color.accentColor.opacity(0.0)],
        startPoint: .top, endPoint: .bottom
    )
    static let muted = LinearGradient(
        colors: [Color.nx.ink3.opacity(0.18), Color.nx.ink3.opacity(0.0)],
        startPoint: .top, endPoint: .bottom
    )
    static let identityAvatar = LinearGradient(
        colors: [Color.accentColor, Color.accentColor.opacity(0.7)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
}
