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
            if model.noAgentReachable {
                // Zero agents reachable: distinct warning banner (not the
                // benign empty-data message). The credentials table is not
                // rendered in this state.
                unreachableBanner(model.unreachableAgents)
                Spacer(minLength: 0)
            } else if model.profiles.isEmpty {
                ContentUnavailableView(
                    "No CC profiles",
                    systemImage: "person.crop.circle.badge.questionmark",
                    description: Text(
                        model.isLoading
                            ? "Loading…"
                            : "Agent reachable but no credential rows configured."
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
            if let source = model.sourceAgentName {
                Text("via \(source)")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .accessibilityIdentifier("credentials-source-attribution")
            }
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

    /// Warning banner shown only when zero agents are reachable — modeled on
    /// `SessionsView.unknownSessionBannerView` (thin bar under the header) but
    /// warning-tinted per `ElevenLabsStatusChip`'s `.keyInvalid` case
    /// (exclamationmark.triangle + red). Names the agents that failed to
    /// respond. Spec: implement-native-credential-page-status (task 3.2, bd:nx-6q4dt)
    private func unreachableBanner(_ agents: [String]) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
            Text(
                agents.isEmpty
                    ? "No agent reachable — credential pool unavailable."
                    : "No agent reachable — \(agents.joined(separator: ", ")) did not respond."
            )
            .font(.caption.monospaced())
            .foregroundStyle(.red)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(Color.red.opacity(0.10))
        .accessibilityIdentifier("credentials-unreachable-banner")
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
    /// Per-account 5h utilization series for the sparkline beneath the bars.
    /// Loaded on `.task`; empty until the agent answers (or forever on older
    /// agents / accounts with no history yet — the chart hides itself).
    @State private var usageHistory: [NexusShared.UsageHistoryPoint] = []
    /// Composed 5h / 7d usage from `GET /statusline?accountId=` — the
    /// authoritative source now that `GET /credentials` no longer carries usage
    /// fields (redesign-status-usage-endpoints, bd:nx-rqpio). Loaded on `.task`;
    /// `nil` until the agent answers, or forever on an agent older than the
    /// accountId-mode endpoint — in which case the bars fall back to the
    /// `CcProfile` usage fields below.
    @State private var accountUsage: NexusShared.Account5H7D?

    // MARK: - Usage resolvers (statusline accountId-mode -> CcProfile fallback)
    //
    // Prefer the composed `GET /statusline?accountId=` window; fall back to the
    // legacy `CcProfile` usage fields when the endpoint hasn't answered yet
    // (older agent / in-flight load), so the bars never regress to empty.
    private var used5h: Int { accountUsage?.fiveHour.used ?? profile.usage5hUsed ?? 0 }
    private var limit5h: Int { accountUsage?.fiveHour.limit ?? profile.usage5hLimit ?? 0 }
    private var reset5h: Date? { accountUsage?.fiveHour.resetsAt ?? profile.usage5hResetAt }
    private var used7d: Int { accountUsage?.sevenDay.used ?? profile.usage7dUsed ?? 0 }
    private var limit7d: Int { accountUsage?.sevenDay.limit ?? profile.usage7dLimit ?? 0 }
    private var reset7d: Date? { accountUsage?.sevenDay.resetsAt ?? profile.usage7dResetAt }

    private var showUsageBars: Bool {
        limit5h > 0 && limit7d > 0
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
                    if !profile.mcpProviderList.isEmpty {
                        mcpPills
                    }
                }
                Spacer()
                trailingControls
            }
            if showUsageBars {
                usageBars
                    .padding(.leading, 14)
                    .padding(.trailing, 6)
                CredentialsUsageHistoryChart(points: usageHistory, label: "5h")
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
        .task(id: profile.id) {
            usageHistory = await model.usageHistory(id: profile.id)
            accountUsage = await model.accountUsage(id: profile.id)
        }
    }

    /// One colored pill per MCP provider (full lowercase name), reusing the
    /// same inline pill recipe as the ACTIVE / duplicates badges above
    /// (padded Text + `.background(color.opacity(0.18))` + cornerRadius 3).
    /// Renders nothing when the profile has no MCP providers.
    /// Spec: implement-native-credential-page-status (task 3.4, bd:nx-7kll2)
    private var mcpPills: some View {
        HStack(spacing: 4) {
            ForEach(profile.mcpProviderList, id: \.self) { provider in
                Text(provider)
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.purple.opacity(0.18))
                    .foregroundStyle(Color.purple)
                    .cornerRadius(3)
            }
        }
        .accessibilityIdentifier("credentials-mcp-pills")
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
                    used: used5h,
                    limit: limit5h,
                    resetAt: reset5h,
                    label: "5h"
                )
                CredentialsUsageBar(
                    used: used7d,
                    limit: limit7d,
                    resetAt: reset7d,
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
    /// True only when the most recent `load()` found ZERO reachable agents.
    /// Drives the distinct warning banner (vs. the empty-data message shown
    /// when an agent IS reachable but returned no credential rows).
    /// Spec: implement-native-credential-page-status (task 3.1, bd:nx-w28ae)
    @Published private(set) var noAgentReachable: Bool = false
    /// Agents that failed to respond on the most recent `load()` — named in
    /// the warning banner. Empty when at least one agent is reachable.
    @Published private(set) var unreachableAgents: [String] = []
    /// The reachable agent that supplied the loaded credentials (first
    /// responder) — surfaced as "via <agent-name>" in the header. Nil until a
    /// successful load with at least one reachable agent.
    @Published private(set) var sourceAgentName: String?
    /// Per-row refresh-identity error stamps. Cleared after 2 s. The view
    /// keys its red-dot indicator off this dict.
    @Published var refreshError: [String: Date] = [:]

    private let client: NexusShared.NexusAggregateClient

    init() {
        self.client = NexusShared.NexusAggregateClient()
    }

    /// Test seam: inject an aggregate client (e.g. one wired to a loopback
    /// stub or an unreachable port) so `load()`'s reachability distinction
    /// can be exercised without the config-driven agent pool.
    init(client: NexusShared.NexusAggregateClient) {
        self.client = client
    }

    func load(dedupe: Bool) async {
        isLoading = true
        defer { isLoading = false }
        // Aggregate merges every reachable agent; per-agent failure is
        // swallowed. Distinguish "no agent reachable at all" (scary warning
        // banner) from "agent reachable, zero credential rows" (benign
        // empty-data message) using the reachability signal fetchCredentials
        // now captures.
        let rows = await client.fetchCredentials(dedupe: dedupe)
        let reachable = await client.reachableAgentNames
        let configured = await client.configuredAgentNames
        profiles = rows.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive }
            let lhsKey = lhs.accountEmail ?? lhs.name
            let rhsKey = rhs.accountEmail ?? rhs.name
            return lhsKey < rhsKey
        }
        noAgentReachable = reachable.isEmpty
        unreachableAgents = configured.filter { !reachable.contains($0) }
        sourceAgentName = reachable.first
        lastError = reachable.isEmpty
            ? "No agent reachable — credential pool not available."
            : nil
    }

    /// Fetch the per-account 5h utilization series for the sparkline. The
    /// aggregate client fans out to every agent; the credential's owner
    /// answers and the rest return `[]`. Empty result = no history yet (or
    /// older agent) — the chart hides itself.
    func usageHistory(id: String) async -> [NexusShared.UsageHistoryPoint] {
        await client.fetchUsageHistory(id: id, window: "5h")
    }

    /// Composed 5h / 7d usage for one account via `GET /statusline?accountId=`.
    /// The aggregate client fans out; the owning agent answers and the rest
    /// 404 (dropped). Returns `nil` when no agent has this account or every
    /// agent is older than the accountId-mode endpoint — the row then falls
    /// back to the `CcProfile` usage fields. bd:nx-rqpio.
    func accountUsage(id: String) async -> NexusShared.Account5H7D? {
        await client.fetchAccountUsage(accountId: id)
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
