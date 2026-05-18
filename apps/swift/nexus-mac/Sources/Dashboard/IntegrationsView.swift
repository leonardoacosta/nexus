// IntegrationsView — macOS dashboard parity for apps/nextjs/src/app/integrations.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.10)
// bd:nx-gaquu
//
// Read-only listing of every wired integration (Better Stack, PostHog,
// Vercel, Linear, ElevenLabs). Source: `NexusClient.fetchIntegrations()`
// (GET /integrations). Older agents that only ship per-integration
// sub-routes return 404; the client coerces that to `[]` and this view
// degrades to an empty state.

import SwiftUI
import NexusShared

struct IntegrationsView: View {
    @StateObject private var model = IntegrationsViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.integrations.isEmpty {
                ContentUnavailableView(
                    "No integrations",
                    systemImage: "link.badge.plus",
                    description: Text(
                        model.isLoading
                            ? "Loading…"
                            : "Agent does not expose GET /integrations. Use the legacy /integrations/elevenlabs route from the web dashboard until the aggregate endpoint ships."
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                listBody
            }
        }
        .padding(.vertical, 8)
        .task {
            await model.load()
        }
        .refreshable {
            await model.load()
        }
    }

    private var header: some View {
        HStack {
            Text("INTEGRATIONS")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(model.integrations.count)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            Button {
                Task { await model.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh")
            .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 14)
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(model.integrations) { integration in
                    IntegrationRow(integration: integration)
                    Divider().padding(.leading, 14)
                }
            }
        }
    }
}

private struct IntegrationRow: View {
    let integration: IntegrationStatus

    var body: some View {
        HStack {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(integration.name)
                    .font(.system(.body, design: .monospaced))
                HStack(spacing: 8) {
                    Text(integration.status)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    if let detail = integration.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if let seen = integration.lastSeenAt {
                    Text(seen, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                } else {
                    Text("never")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let manage = integration.manageUrl, let url = URL(string: manage) {
                    Link("manage", destination: url)
                        .font(.caption2.monospaced())
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private var statusColor: Color {
        switch integration.status.lowercased() {
        case "connected", "ok":  return .green
        case "disconnected":     return .secondary
        case "error":            return .red
        case "not-configured":   return .yellow
        default:                 return .secondary
        }
    }
}

@MainActor
final class IntegrationsViewModel: ObservableObject {
    @Published private(set) var integrations: [IntegrationStatus] = []
    @Published private(set) var isLoading: Bool = false

    private let client: NexusShared.NexusClient = NexusShared.NexusClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let rows = try await client.fetchIntegrations()
            integrations = rows.sorted { $0.name < $1.name }
        } catch {
            // Non-fatal — empty list + refresh affordance.
            integrations = []
        }
    }
}
