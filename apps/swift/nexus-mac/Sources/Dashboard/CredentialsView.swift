// CredentialsView — macOS dashboard parity for apps/nextjs/src/app/credentials.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.5)
// bd:nx-gaquu
//
// Extended by credentials-account-resolve-and-usage (tasks 3.4-3.7):
//   - per-row 5h / 7d usage bars with reset countdowns (CredentialsUsageBar)
//   - refresh-identity button on rows with blank email
//   - dedupe toggle (default ON) collapsing duplicate groups
//   - inline siblings expansion ("+N duplicates" chip)
//
// Read-only mirror of the agent's CC profile pool. Source data comes from
// `NexusClient.fetchCredentials(dedupe:)` which exposes the flat profile
// list plus an `activeFingerprint` stamp. Identity refresh now POSTs back
// — swap and rate-limit decisions still live on the agent side.

import SwiftUI
import NexusShared

struct CredentialsView: View {
    @StateObject private var model = CredentialsViewModel()
    @AppStorage("credentials.dedupe") private var dedupeEnabled: Bool = true

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
            await model.load(dedupe: dedupeEnabled)
        }
        .refreshable {
            await model.load(dedupe: dedupeEnabled)
        }
        .onChange(of: dedupeEnabled) { _, newValue in
            Task { await model.load(dedupe: newValue) }
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
            Toggle("Dedupe", isOn: $dedupeEnabled)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .help("Collapse rows that share an OAuth refresh token")
            Button {
                Task { await model.load(dedupe: dedupeEnabled) }
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
                    CredentialRow(profile: profile, model: model)
                    Divider().padding(.leading, 14)
                }
            }
        }
    }
}

private struct CredentialRow: View {
    let profile: NexusShared.CcProfile
    @ObservedObject var model: CredentialsViewModel
    @State private var expandSiblings: Bool = false

    private var showUsageBars: Bool {
        profile.usage5hLimit != nil && profile.usage7dLimit != nil
    }

    private var showRefreshIdentity: Bool {
        profile.accountEmail == nil
    }

    private var siblingChipCount: Int {
        profile.siblingCount ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
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
                        if siblingChipCount > 0 {
                            Button {
                                expandSiblings.toggle()
                            } label: {
                                Text("+\(siblingChipCount) duplicates")
                                    .font(.caption2.monospaced())
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(Color.accentColor.opacity(0.15))
                                    .foregroundStyle(Color.accentColor)
                                    .cornerRadius(3)
                            }
                            .buttonStyle(.plain)
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
                trailingControls
            }
            if showUsageBars {
                usageBars
                    .padding(.leading, 14)
                    .padding(.trailing, 6)
            }
            if expandSiblings, let ids = profile.siblingIds, !ids.isEmpty {
                siblingsList(ids: ids)
                    .padding(.leading, 28)
                    .padding(.trailing, 6)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var trailingControls: some View {
        VStack(alignment: .trailing, spacing: 2) {
            if showRefreshIdentity {
                refreshIdentityButton
            }
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

    private var refreshIdentityButton: some View {
        Button {
            Task { await model.refreshIdentity(id: profile.id) }
        } label: {
            HStack(spacing: 2) {
                Image(systemName: "arrow.clockwise.circle")
                if model.refreshError[profile.id] != nil {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 6, height: 6)
                }
            }
        }
        .buttonStyle(.borderless)
        .help("Refresh account identity")
    }

    @ViewBuilder
    private var usageBars: some View {
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            VStack(alignment: .leading, spacing: 4) {
                CredentialsUsageBar(
                    used: profile.usage5hUsed ?? 0,
                    limit: profile.usage5hLimit ?? 0,
                    resetAt: profile.usage5hResetAt,
                    label: "5h"
                )
                CredentialsUsageBar(
                    used: profile.usage7dUsed ?? 0,
                    limit: profile.usage7dLimit ?? 0,
                    resetAt: profile.usage7dResetAt,
                    label: "7d"
                )
            }
        }
    }

    private func siblingsList(ids: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(ids, id: \.self) { id in
                HStack(spacing: 6) {
                    Text(id)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    Spacer()
                    // Delete-sibling UX is intentionally a stub here — wiring
                    // up DELETE /credentials/:id with the orphan-protection
                    // promote-then-delete dance lives in a follow-up spec.
                    // The button is left disabled so the surface ships but
                    // the action defers to that follow-up.
                    Button {
                        // no-op; see comment above
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                    .disabled(true)
                    .help("Delete sibling (follow-up — disabled in v1)")
                }
            }
        }
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
    /// Per-row refresh-identity error stamps. Cleared after 2 s. The view
    /// keys its red-dot indicator off this dict.
    @Published var refreshError: [String: Date] = [:]

    private let client = NexusShared.NexusAggregateClient()

    func load(dedupe: Bool) async {
        isLoading = true
        defer { isLoading = false }
        // Aggregate merges every reachable agent; per-agent failure is
        // swallowed. Only flag an error when nothing came back at all.
        let rows = await client.fetchCredentials(dedupe: dedupe)
        profiles = rows.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive }
            let lhsKey = lhs.accountEmail ?? lhs.name
            let rhsKey = rhs.accountEmail ?? rhs.name
            return lhsKey < rhsKey
        }
        lastError = rows.isEmpty ? "No agent reachable — credential pool not available." : nil
    }

    /// Re-probe a single credential's identity and optimistically update
    /// the local row. On failure, stamp `refreshError[id]` for a 2-second
    /// red-dot indicator then clear it.
    func refreshIdentity(id: String) async {
        guard let updated = await client.refreshCredentialIdentity(id: id) else {
            refreshError[id] = Date()
            // Auto-clear the error after 2 s.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                refreshError.removeValue(forKey: id)
            }
            return
        }
        // Optimistic in-place mutation — keep the row order stable.
        // CcProfile only exposes the fields the dashboard renders; the
        // refresh-identity response also carries accountUuid + orgUuid but
        // those aren't surfaced in the row, so we drop them on the floor
        // and let the next `load()` sync any other downstream changes.
        if let idx = profiles.firstIndex(where: { $0.id == id }) {
            var row = profiles[idx]
            row.accountEmail = updated.accountEmail
            row.accountName = updated.accountName
            row.orgName = updated.orgName
            profiles[idx] = row
        }
    }
}
