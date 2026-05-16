//
//  Typography.swift
//  nexus
//
//  Wireframe calls for JetBrains Mono. The TTF files can be dropped into
//  Resources/Fonts/ and registered via `ATSApplicationFontsPath` in Info.plist
//  (the macOS equivalent of iOS's `UIAppFonts`). Until they're bundled, this
//  helper resolves to system mono so the rest of the UI compiles unchanged —
//  swap-in is a one-line change in `resolvedName(for:)`.
//

import SwiftUI

extension Font {
    /// Ergonomic call site: `Font.jbm(11, weight: .semibold)`.
    static func jbm(_ size: CGFloat, weight: Weight = .regular) -> Font {
        let resolved = JBM.resolvedName(for: weight)
        if let name = resolved {
            // Custom font present — use it. Fixed-design size keeps Dynamic Type
            // off (we want mono glyph alignment, not user-scaled mono).
            return .custom(name, fixedSize: size)
        }
        // Fallback: system monospaced face mapped to the requested weight.
        return .system(size: size, weight: weight, design: .monospaced)
    }
}

private enum JBM {
    /// Map Swift weights to the JetBrains Mono PostScript font names. If the
    /// font isn't currently registered with NSFontManager (i.e. not bundled
    /// yet), return `nil` so the call site falls back to `Font.system(...)`.
    static func resolvedName(for weight: Font.Weight) -> String? {
        let candidate: String
        switch weight {
        case .light, .ultraLight, .thin:           candidate = "JetBrainsMono-Light"
        case .regular:                              candidate = "JetBrainsMono-Regular"
        case .medium:                               candidate = "JetBrainsMono-Medium"
        case .semibold:                             candidate = "JetBrainsMono-SemiBold"
        case .bold, .heavy, .black:                 candidate = "JetBrainsMono-Bold"
        default:                                    candidate = "JetBrainsMono-Regular"
        }
        return JBM.isRegistered(candidate) ? candidate : nil
    }

    private static var registeredCache: [String: Bool] = [:]
    private static let cacheLock = NSLock()

    private static func isRegistered(_ name: String) -> Bool {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let cached = registeredCache[name] { return cached }
        // NSFont init returns nil for unknown names; CFArray query would
        // also work but this is the smallest portable check.
        let ok = NSFont(name: name, size: 12) != nil
        registeredCache[name] = ok
        return ok
    }
}
