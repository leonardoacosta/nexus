// CredentialsView — macOS dashboard parity for apps/nextjs/src/app/credentials.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.5)
// bd:nx-gaquu
//
// Read-only mirror of the agent's CC profile pool. Source data comes from
// `NexusClient.fetchCredentials()` (GET /credentials) which exposes the
// flat profile list plus an `activeFingerprint` stamp. The view never
// POSTs back — swap and refresh decisions live in cc-credential-manager
// on the agent side.

import SwiftUI
import NexusShared

struct CredentialsView: View {
    @StateObject private var model = CredentialsViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.profiles.isEmpty {
                ContentUnavailableView(
                    "No CC profiles",
                    systemImage: "person.crop.circle.badge.questionmark",
                    description: Text(
                        model.isLoading
                            ? "Loading…"
                            : (model.lastError ?? "Agent reachable but no credential rows configured.")
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
            Text("CREDENTIALS")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(model.profiles.count)")
                .font(.system(.caption2, design: .monospaced))
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
                ForEach(model.profiles) { profile in
                    CredentialRow(profile: profile)
                    Divider().padding(.leading, 14)
                }
            }
        }
    }
}

private struct CredentialRow: View {
    let profile: NexusShared.CcProfile

    var body: some View {
        HStack(alignment: .center) {
            statusBadge
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(profile.accountEmail ?? profile.name)
                        .font(.system(.body, design: .monospaced))
                    if profile.isActive {
                        Text("ACTIVE")
                            .font(.caption2.monospaced())
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.green.opacity(0.18))
                            .foregroundStyle(.green)
                            .cornerRadius(3)
                    }
                }
                HStack(spacing: 8) {
                    if let plan = profile.subscriptionType {
                        Text(plan.uppercased())
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    if let tier = profile.rateLimitTier {
                        Text(tier)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    Text(profile.oauthState)
                        .font(.caption2.monospaced())
                        .foregroundStyle(oauthColor)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if profile.rateLimit429Count > 0 {
                    Text("\(profile.rateLimit429Count)× 429")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.orange)
                }
                if let swap = profile.lastSwapAt {
                    Text(swap, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private var statusBadge: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
    }

    private var statusColor: Color {
        switch profile.status.lowercased() {
        case "active":      return .green
        case "rate_limited", "rate-limited": return .orange
        case "cooldown":    return .yellow
        case "revoked", "expired": return .red
        default:            return .secondary
        }
    }

    private var oauthColor: Color {
        switch profile.oauthState {
        case "valid":      return .green
        case "expired":    return .red
        case "refreshing": return .yellow
        default:           return .secondary
        }
    }
}

@MainActor
final class CredentialsViewModel: ObservableObject {
    @Published private(set) var profiles: [NexusShared.CcProfile] = []
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var lastError: String?

    private let client: NexusShared.NexusClient = NexusShared.NexusClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let rows = try await client.fetchCredentials()
            profiles = rows.sorted { lhs, rhs in
                if lhs.isActive != rhs.isActive { return lhs.isActive }
                let lhsKey = lhs.accountEmail ?? lhs.name
                let rhsKey = rhs.accountEmail ?? rhs.name
                return lhsKey < rhsKey
            }
            lastError = nil
        } catch {
            lastError = "Agent unreachable — credential pool not available."
        }
    }
}
