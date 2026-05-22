// SettingsDashboardView — dashboard preferences (refresh, default view,
// theme, accent, font scale).
//
// Spec: openspec/changes/settings-tab-redesign (task 2.7, bd:nx-c8n8j)
//
// Persistence keys reuse the literals already in use by the legacy
// SettingsViewModel (`nx.dashboard.refreshSeconds`, `nx.dashboard.defaultView`)
// so existing preferences are preserved verbatim. Theme/accent/fontScale
// are new keys introduced by this spec.

import SwiftUI
import NexusShared

enum DashboardTheme: String, CaseIterable, Identifiable {
    case system, dark, light
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: return "System"
        case .dark:   return "Dark"
        case .light:  return "Light"
        }
    }
}

enum DashboardFontScale: String, CaseIterable, Identifiable {
    case normal, compact
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct SettingsDashboardView: View {
    @AppStorage("nx.dashboard.refreshSeconds")
    private var refreshSeconds: Int = 30

    @AppStorage("nx.dashboard.defaultView")
    private var defaultView: String = "sessions"

    @AppStorage("nx.dashboard.theme")
    private var themeRaw: String = DashboardTheme.system.rawValue

    /// Stored as a hex string (e.g. `#0a84ff`). NSColor parsing is done
    /// at read-time on the consumer side. ColorPicker writes the round-trip.
    @AppStorage("nx.dashboard.accentHex")
    private var accentHex: String = "#0a84ff"

    @AppStorage("nx.dashboard.fontScale")
    private var fontScaleRaw: String = DashboardFontScale.normal.rawValue

    private var theme: Binding<DashboardTheme> {
        Binding(
            get: { DashboardTheme(rawValue: themeRaw) ?? .system },
            set: { themeRaw = $0.rawValue }
        )
    }

    private var fontScale: Binding<DashboardFontScale> {
        Binding(
            get: { DashboardFontScale(rawValue: fontScaleRaw) ?? .normal },
            set: { fontScaleRaw = $0.rawValue }
        )
    }

    private var accentColor: Binding<Color> {
        Binding(
            get: { Color(hex: accentHex) ?? .accentColor },
            set: { accentHex = $0.toHex() ?? "#0a84ff" }
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Dashboard").font(.title3).bold()

                HStack {
                    Text("Refresh interval")
                    Spacer()
                    Stepper("\(refreshSeconds)s",
                            value: $refreshSeconds,
                            in: 5...300,
                            step: 5)
                }
                Picker("Default view", selection: $defaultView) {
                    Text("Sessions").tag("sessions")
                    Text("Specs").tag("specs")
                    Text("Projects").tag("projects")
                    Text("Health").tag("health")
                    Text("Notifications").tag("notifications")
                }
                Picker("Theme", selection: theme) {
                    ForEach(DashboardTheme.allCases) { t in
                        Text(t.label).tag(t)
                    }
                }
                ColorPicker("Accent color", selection: accentColor, supportsOpacity: false)
                Picker("Font scale", selection: fontScale) {
                    ForEach(DashboardFontScale.allCases) { f in
                        Text(f.label).tag(f)
                    }
                }
                Spacer(minLength: 12)
            }
            .padding(20)
        }
    }
}

// MARK: - Color hex helpers (local — keep theme persistence self-contained).

private extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xff) / 255.0
        let g = Double((value >> 8) & 0xff) / 255.0
        let b = Double(value & 0xff) / 255.0
        self = Color(red: r, green: g, blue: b)
    }

    /// Round-trips through NSColor → sRGB to extract components portable
    /// across colour spaces (Color does not expose components directly on
    /// macOS 14 / Swift 5.10).
    func toHex() -> String? {
        #if os(macOS)
        let ns = NSColor(self).usingColorSpace(.sRGB) ?? NSColor(self)
        let r = Int((ns.redComponent * 255).rounded())
        let g = Int((ns.greenComponent * 255).rounded())
        let b = Int((ns.blueComponent * 255).rounded())
        return String(format: "#%02x%02x%02x", r, g, b)
        #else
        return nil
        #endif
    }
}
