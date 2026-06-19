// SettingsView — NavigationSplitView shell for the redesigned Settings tab.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.1, bd:nx-5il4b)
//
// Sidebar lists five categories; detail pane swaps in one of five dedicated
// SettingsXxxView files. Selection persists via @AppStorage so the user
// returns to the same pane on relaunch. The previous flat-Form layout is
// removed — every code path into Settings lands here.

import SwiftUI
import NexusShared

/// Five categories surfaced in the sidebar. Raw values double as the
/// @AppStorage payload (`tts`/`notifications`/.../`diagnostics`).
enum SettingsCategory: String, CaseIterable, Identifiable {
    case tts
    case notifications
    case routing
    case agents
    case dashboard
    case diagnostics

    var id: String { rawValue }

    var label: String {
        switch self {
        case .tts:           return "TTS & Audio"
        case .notifications: return "Notifications"
        case .routing:       return "Routing"
        case .agents:        return "Agents"
        case .dashboard:     return "Dashboard"
        case .diagnostics:   return "Diagnostics"
        }
    }

    /// SF Symbol per the proposal §2.1.
    var symbol: String {
        switch self {
        case .tts:           return "speaker.wave.2"
        case .notifications: return "bell.badge"
        case .routing:       return "arrow.triangle.branch"
        case .agents:        return "network"
        case .dashboard:     return "slider.horizontal.3"
        case .diagnostics:   return "waveform.path.ecg"
        }
    }
}

/// Thin router model — owns the sidebar selection only. Each category view
/// owns its own @StateObject; this view-model intentionally carries nothing
/// else (split from the legacy SettingsViewModel per task 2.10, bd:nx-8ltyr).
@MainActor
final class SettingsRouterViewModel: ObservableObject {
    /// Backed by @AppStorage at the View layer — duplicated here as a
    /// fallback for callers that need an in-process source-of-truth without
    /// touching SwiftUI APIs (e.g. tests).
    @Published var selection: SettingsCategory = .tts
}

struct SettingsView: View {
    @AppStorage("settings.sidebar.selection")
    private var selectionRaw: String = SettingsCategory.tts.rawValue

    private var selection: Binding<SettingsCategory> {
        Binding(
            get: { SettingsCategory(rawValue: selectionRaw) ?? .tts },
            set: { selectionRaw = $0.rawValue }
        )
    }

    var body: some View {
        NavigationSplitView {
            List(SettingsCategory.allCases, selection: selection) { category in
                Label(category.label, systemImage: category.symbol)
                    .tag(category)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
            .navigationTitle("Settings")
        } detail: {
            detailPane(for: selection.wrappedValue)
                .frame(minWidth: 480, idealWidth: 560, minHeight: 360)
        }
    }

    @ViewBuilder
    private func detailPane(for category: SettingsCategory) -> some View {
        switch category {
        case .tts:           SettingsTtsView()
        case .notifications: SettingsNotificationsView()
        case .routing:       SettingsRoutingView()
        case .agents:        SettingsAgentsView()
        case .dashboard:     SettingsDashboardView()
        case .diagnostics:   SettingsDiagnosticsView()
        }
    }
}
