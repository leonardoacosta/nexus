// SourceIndexView — macOS three-pane "Source Index / App Shell" for nexus-mac.
//
// Spec: mx-bzzb [nx-ui] Shell / source index view (epic mx-rkir).
// Wireframe: docs/nx-ui/nx-wireframe-shell-source-index.html (mx repo).
//
// Renders the mx aggregator's registry fan-out over mx/v1/source.proto:
//   • sidebar — MINE "ball in court" hero + Triage section (aggregated
//     sources) + Sources section (own surfaces), each row carrying a health
//     dot (SERVING/DEGRADED/NOT_SERVING) + reason + relative last-sync +
//     item-count + MINE badge + capability cues (search affordance / LIVE).
//   • middle pane — cross-source MINE inbox preview ("Ball in Court").
//   • detail pane — "Select an item" empty state (READ-ONLY: the only action
//     is "Open in source" via Core.url).
//   • footer — CLI-style per-source status line.
//
// HIG-native + adaptive: uses SwiftUI semantic colors (.green/.orange/.red,
// .blue accent) so it tracks light/dark exactly like the wireframe. The dark
// phosphor `Color.nx.*` palette is the menubar theme, not this surface.
//
// Backing endpoint is unshipped (Wave-4): the observer 404s into an empty
// index today, so the view shows graceful loading / empty states. The
// #Preview drives representative MOCK data so it renders + compiles.

import SwiftUI
import NexusShared

struct SourceIndexView: View {
    @StateObject private var observer: SourceIndexObserver
    @State private var selectedSourceID: String?

    /// Default-constructs its own observer (the live path). `View` body /
    /// property init runs on the main actor, so the @MainActor-isolated
    /// `SourceIndexObserver()` is reachable here. The `#Preview` injects a
    /// mock-seeded observer via the explicit initializer.
    init() {
        _observer = StateObject(wrappedValue: SourceIndexObserver())
    }

    /// Injection seam for previews / tests (mock-seeded observer).
    init(observer: SourceIndexObserver) {
        _observer = StateObject(wrappedValue: observer)
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 248, max: 300)
        } content: {
            inboxPane
                .navigationSplitViewColumnWidth(min: 300, ideal: 330, max: 420)
        } detail: {
            detailPane
        }
        .navigationTitle("Sources")
        .accessibilityIdentifier("source-index-view")
        .task {
            observer.startPolling()
        }
        .onDisappear {
            observer.stopPolling()
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        List(selection: $selectedSourceID) {
            Section {
                MineHeroCell(
                    count: observer.index.mineHeroCount,
                    sourceCount: observer.index.aggregatedSourceCount
                )
                .listRowInsets(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
                .listRowBackground(Color.clear)
            }

            switch observer.phase {
            case .loading where observer.index.sources.isEmpty:
                Section {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading sources…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("source-index-loading")
                }
            case .error(let message):
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("source-index-error")
                }
            default:
                if observer.index.sources.isEmpty {
                    Section {
                        Text("No sources reporting yet.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("source-index-empty")
                    }
                } else {
                    triageSection
                    ownSurfacesSection
                }
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private var triageSection: some View {
        let rows = observer.index.aggregatedSources
        if !rows.isEmpty {
            Section("Triage") {
                ForEach(rows) { source in
                    SourceSidebarRow(source: source)
                        .tag(source.id)
                }
            }
        }
    }

    @ViewBuilder
    private var ownSurfacesSection: some View {
        let rows = observer.index.ownSurfaceSources
        if !rows.isEmpty {
            Section("Sources") {
                ForEach(rows) { source in
                    SourceSidebarRow(source: source)
                        .tag(source.id)
                }
            }
        }
    }

    // MARK: - Middle pane (cross-source MINE inbox preview)

    private var inboxPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Ball in Court")
                    .font(.title2.bold())
                Text("\(observer.index.mineHeroCount) items where ball_in_court == MINE · all aggregated sources")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            if observer.index.inbox.isEmpty {
                ContentUnavailableView(
                    "Nothing owed",
                    systemImage: "tray",
                    description: Text("No items are currently in your court across the aggregated sources.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(observer.index.inbox) { item in
                        InboxPreviewRow(item: item)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                }
                .listStyle(.plain)
            }

            Divider()
            statusFooter
        }
        .accessibilityIdentifier("source-index-inbox")
    }

    private var statusFooter: some View {
        HStack(spacing: 0) {
            if observer.index.aggregatedSources.isEmpty {
                Text("aggregate status pending")
                    .foregroundStyle(.tertiary)
            } else {
                // Color-coded per-source fragments, mirroring the wireframe's
                // green/red/orange CLI footer.
                ForEach(Array(observer.index.aggregatedSources.enumerated()), id: \.element.id) { idx, source in
                    if idx > 0 {
                        Text(" | ").foregroundStyle(.tertiary)
                    }
                    Text(source.footerFragment)
                        .foregroundStyle(footerColor(for: source.health))
                }
            }
        }
        .font(.system(.caption2, design: .monospaced))
        .lineLimit(1)
        .truncationMode(.tail)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("source-index-status-footer")
    }

    // MARK: - Detail pane

    @ViewBuilder
    private var detailPane: some View {
        ContentUnavailableView {
            Label("Select an item", systemImage: "rectangle.split.1x2")
        } description: {
            Text("Choose a triage item from the Ball in Court list to view its detail. The only action is \u{201C}Open in source\u{201D} via the read-only Core.url deep link.")
        }
        .frame(minWidth: 320, minHeight: 240)
        .accessibilityIdentifier("source-index-detail-empty")
    }

    private func footerColor(for health: SourceHealth) -> Color {
        switch health {
        case .serving:    return .green
        case .degraded:   return .orange
        case .notServing: return .red
        case .unknown:    return .secondary
        }
    }
}

// MARK: - Sidebar hero cell

private struct MineHeroCell: View {
    let count: Int
    let sourceCount: Int

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "tray.full")
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(Color.white.opacity(0.22), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text("\(count)")
                    .font(.title.bold())
                    .foregroundStyle(.white)
                Text("Ball in your court")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.92))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                colors: [.blue, Color(red: 0.04, green: 0.39, blue: 0.90)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 9)
        )
        .accessibilityIdentifier("source-index-mine-hero")
        .accessibilityLabel("\(count) items in your court across \(sourceCount) aggregated sources")
    }
}

// MARK: - Sidebar source row

private struct SourceSidebarRow: View {
    let source: SourceStatus

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(source.displayName)
                        .font(.callout)
                        .lineLimit(1)
                    HealthDot(health: source.health)
                    if source.canStream {
                        LiveBadge()
                    }
                }
                Text(subtitle)
                    .font(.system(size: 10.5))
                    .foregroundStyle(subtitleColor)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if source.canSearch {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(.blue)
                    .accessibilityHidden(true)
            }
            trailingCount
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("source-row-\(source.id)")
    }

    /// Aggregated rows show the MINE badge; own-surface rows show a plain
    /// item-count pill (per the wireframe: sessions/health/plaid carry no
    /// MINE badge).
    @ViewBuilder
    private var trailingCount: some View {
        if source.inAggregate {
            MineBadge(count: source.mineCount)
        } else if let n = source.itemCount {
            Text("\(n)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private var subtitle: String {
        switch source.health {
        case .degraded, .notServing:
            if let reason = source.healthReason, !reason.isEmpty {
                return "\(source.health.footerToken) · \(reason)"
            }
            return source.health.footerToken
        default:
            var parts: [String] = []
            if let kind = source.producesKind, !kind.isEmpty { parts.append(kind) }
            if let sync = source.lastSyncAt {
                parts.append("synced \(Self.relative.localizedString(for: sync, relativeTo: Date()))")
            }
            return parts.joined(separator: " · ")
        }
    }

    private var subtitleColor: Color {
        switch source.health {
        case .notServing: return .red
        case .degraded:   return .orange
        default:          return .secondary
        }
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
}

// MARK: - Inbox preview row

private struct InboxPreviewRow: View {
    let item: BallInCourtItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(lineColor)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(item.author.isEmpty ? "—" : item.author)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let ts = item.lastActivityAt {
                        Text(Self.relative.localizedString(for: ts, relativeTo: Date()))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(item.title)
                    .font(.system(size: 13))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(item.source)
                        .font(.system(size: 10, weight: .semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
                    if let kind = item.producesKind, !kind.isEmpty {
                        Text(kind)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .accessibilityIdentifier("inbox-row-\(item.id)")
    }

    private var lineColor: Color {
        switch item.ballInCourt {
        case .mine:    return .blue
        case .theirs:  return .gray
        case .unclear: return .orange
        }
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
}

// MARK: - Shared chrome

private struct HealthDot: View {
    let health: SourceHealth

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityLabel(health.footerToken)
    }

    private var color: Color {
        switch health {
        case .serving:    return .green
        case .degraded:   return .orange
        case .notServing: return .red
        case .unknown:    return .gray
        }
    }
}

private struct LiveBadge: View {
    var body: some View {
        Text("LIVE")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(.red)
            .padding(.horizontal, 3)
            .padding(.vertical, 0.5)
            .overlay(
                RoundedRectangle(cornerRadius: 3)
                    .stroke(Color.red, lineWidth: 1)
            )
            .accessibilityLabel("live")
    }
}

private struct MineBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .frame(minWidth: 18, minHeight: 17)
            .padding(.horizontal, 4)
            .background(count == 0 ? Color.gray.opacity(0.6) : Color.blue, in: Capsule())
            .accessibilityLabel("\(count) in your court")
    }
}

// MARK: - Preview (mock data — endpoint unshipped)

#if DEBUG
#Preview("Source Index (mock)") {
    SourceIndexView(observer: .preview)
        .frame(width: 920, height: 640)
}

extension SourceIndexObserver {
    /// Representative mock data mirroring the wireframe so the view renders +
    /// compiles without the (unshipped) agent endpoint. NOT used in the
    /// shipped app — only `#Preview`.
    static var preview: SourceIndexObserver {
        let obs = SourceIndexObserver()
        obs.setIndexForPreview(.sampleData)
        return obs
    }
}
#endif
