import SwiftUI
import NexusShared

/// iOS Source Index — the compact, single-column counterpart to the macOS
/// `SourceIndexView` NavigationSplitView. Mirrors the wireframe iOS panel:
/// a MINE ball-in-court hero, a "Triage" section (aggregated sources), a
/// "Sources" section (own surfaces), and a color-coded status footer.
///
/// The live `/sources` aggregate endpoint is not built yet (returns empty), so
/// when the observer has no live data we render `SourceIndex.sampleData` behind
/// a visible "Sample data" caption — Leo sees a populated page, honestly marked.
struct SourcesScene: View {
    @ObservedObject private var observer: SourceIndexObserver

    init(observer: SourceIndexObserver) {
        self.observer = observer
    }

    /// True when there is no live data to show and we fall back to the sample.
    private var isSample: Bool {
        observer.index.sources.isEmpty
    }

    /// The index actually rendered — live when present, sample otherwise.
    private var displayIndex: SourceIndex {
        isSample ? .sampleData : observer.index
    }

    var body: some View {
        List {
            heroSection
            if isSample {
                sampleCaptionSection
            }
            triageSection
            ownSurfacesSection
            footerSection
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("sources-scene")
        .task {
            observer.startPolling()
        }
        .onDisappear {
            observer.stopPolling()
        }
    }

    // MARK: - Sections

    private var heroSection: some View {
        Section {
            MineHeroCell(
                count: displayIndex.mineHeroCount,
                sourceCount: displayIndex.aggregatedSourceCount
            )
            .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            .listRowBackground(Color.clear)
        }
    }

    private var sampleCaptionSection: some View {
        Section {
            Label(
                "Sample data — live /sources pending (mx-dn7t)",
                systemImage: "exclamationmark.circle"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("sources-sample-caption")
        }
    }

    @ViewBuilder
    private var triageSection: some View {
        let rows = displayIndex.aggregatedSources
        if !rows.isEmpty {
            Section {
                ForEach(rows) { source in
                    SourceRow(source: source)
                }
            } header: {
                Text("Triage")
            } footer: {
                Text("\(displayIndex.mineHeroCount) items where the ball is in your court across \(rows.count) aggregated sources.")
            }
        }
    }

    @ViewBuilder
    private var ownSurfacesSection: some View {
        let rows = displayIndex.ownSurfaceSources
        if !rows.isEmpty {
            Section("Sources") {
                ForEach(rows) { source in
                    SourceRow(source: source)
                }
            }
        }
    }

    private var footerSection: some View {
        Section {
            StatusFooter(sources: displayIndex.aggregatedSources)
        }
    }
}

// MARK: - MINE hero

private struct MineHeroCell: View {
    let count: Int
    let sourceCount: Int

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "tray.full")
                .font(.title2)
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Color.white.opacity(0.22), in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 1) {
                Text("\(count)")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                Text("Ball in your court")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.92))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                colors: [.blue, Color(red: 0.04, green: 0.39, blue: 0.90)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .accessibilityIdentifier("sources-mine-hero")
        .accessibilityLabel("\(count) items in your court across \(sourceCount) aggregated sources")
    }
}

// MARK: - Source row

private struct SourceRow: View {
    let source: SourceStatus

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    HealthDot(health: source.health)
                    Text(source.displayName)
                        .font(.body)
                        .lineLimit(1)
                    if source.canStream {
                        LiveBadge()
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(subtitleColor)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if source.canSearch {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(.blue)
                    .accessibilityHidden(true)
            }
            trailingCount
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("source-row-\(source.id)")
    }

    @ViewBuilder
    private var trailingCount: some View {
        if source.inAggregate {
            MineBadge(count: source.mineCount)
        } else if let n = source.itemCount {
            Text("\(n)")
                .font(.subheadline.monospacedDigit())
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

// MARK: - Status footer

private struct StatusFooter: View {
    let sources: [SourceStatus]

    var body: some View {
        Group {
            if sources.isEmpty {
                Text("aggregate status pending")
                    .foregroundStyle(.tertiary)
            } else {
                HStack(spacing: 0) {
                    ForEach(Array(sources.enumerated()), id: \.element.id) { idx, source in
                        if idx > 0 {
                            Text(" | ").foregroundStyle(.tertiary)
                        }
                        Text(source.footerFragment)
                            .foregroundStyle(footerColor(for: source.health))
                    }
                }
            }
        }
        .font(.system(.caption2, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("sources-status-footer")
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

// MARK: - Shared chrome

private struct HealthDot: View {
    let health: SourceHealth

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
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
            .font(.system(size: 9, weight: .bold))
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
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .frame(minWidth: 20, minHeight: 18)
            .padding(.horizontal, 5)
            .background(count == 0 ? Color.gray.opacity(0.6) : Color.blue, in: Capsule())
            .accessibilityLabel("\(count) in your court")
    }
}

#if DEBUG
#Preview("Sources (sample)") {
    NavigationStack {
        SourcesScene(observer: {
            let obs = SourceIndexObserver()
            obs.setIndexForPreview(.sampleData)
            return obs
        }())
        .navigationTitle("Sources")
    }
}
#endif
