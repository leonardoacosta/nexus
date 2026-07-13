// SettingsPane — the ⌘, settings window (design § 07).
//
// Spec: openspec/changes/refocus-board-shell (task 3.4)
//
// The operational surfaces leave the daily board and become tabs here:
// Credentials, Integrations, Sources, Voices, and General (the existing
// multi-tab `SettingsView`). Each tab WRAPS the existing view body unchanged
// (re-home, don't rewrite). A degraded integration still reaches the user
// without opening this pane — but here it also shows as an amber dot on the
// Integrations tab (design § 07). Hosted by the `Settings { }` scene in
// nexusApp so it binds ⌘, automatically.

import SwiftUI
import NexusShared

enum SettingsTab: String, CaseIterable, Identifiable {
    case credentials
    case integrations
    case sources
    case voices
    case general

    var id: String { rawValue }

    var label: String {
        switch self {
        case .credentials:  return "Credentials"
        case .integrations: return "Integrations"
        case .sources:      return "Sources"
        case .voices:       return "Voices"
        case .general:      return "General"
        }
    }

    var glyph: String {
        switch self {
        case .credentials:  return "key"
        case .integrations: return "link"
        case .sources:      return "square.stack.3d.up"
        case .voices:       return "waveform"
        case .general:      return "gearshape"
        }
    }
}

struct SettingsPane: View {
    @State private var selection: SettingsTab = .credentials
    @StateObject private var health = IntegrationHealthModel()

    var body: some View {
        HStack(spacing: 0) {
            tabRail
                .frame(width: 190)
            Divider().overlay(Color.nx.hairline)
            detail
                .frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 720, minHeight: 460)
        .task { await health.load() }
    }

    private var tabRail: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(SettingsTab.allCases) { tab in
                Button {
                    selection = tab
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: tab.glyph)
                            .frame(width: 16)
                            .foregroundStyle(selection == tab ? Color.nx.phosphor : Color.nx.ink4)
                        Text(tab.label)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(selection == tab ? Color.nx.ink : Color.nx.ink2)
                        Spacer(minLength: 0)
                        if tab == .integrations && health.hasDegraded {
                            Circle().fill(Color.nx.amber).frame(width: 6, height: 6)
                                .accessibilityIdentifier("settings-integrations-degraded")
                        }
                    }
                    .padding(.horizontal, selection == tab ? 16 : 18)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        selection == tab
                            ? LinearGradient(colors: [Color.nx.phosphor.opacity(0.08), .clear],
                                             startPoint: .leading, endPoint: .trailing)
                            : LinearGradient(colors: [.clear], startPoint: .leading, endPoint: .trailing)
                    )
                    .overlay(alignment: .leading) {
                        if selection == tab {
                            Rectangle().fill(Color.nx.phosphor).frame(width: 2)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-tab-\(tab.rawValue)")
            }
            Spacer()
        }
        .padding(.vertical, 16)
        .background(Color.nx.substrate2)
    }

    @ViewBuilder
    private var detail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch selection {
                case .credentials:  CredentialsView()
                case .integrations: IntegrationsView()
                case .sources:      SourceIndexView()
                case .voices:       ProjectVoicesView()
                case .general:      SettingsView()
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Small model that fetches integration health so the Integrations tab can
/// carry an amber degraded dot (design § 07).
@MainActor
final class IntegrationHealthModel: ObservableObject {
    @Published private(set) var hasDegraded = false
    private let client = NexusShared.NexusAggregateClient()

    private static let healthy: Set<String> = ["ok", "healthy", "connected", "live", "up"]

    func load() async {
        let integrations = await client.fetchIntegrations()
        hasDegraded = integrations.contains { !Self.healthy.contains($0.status.lowercased()) }
    }
}
