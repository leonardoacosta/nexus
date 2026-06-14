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
//     Backed by SourceIndexObserver (`/sources`) — UNCHANGED.
//   • middle pane — driven by the sidebar selection over the live `/triage`
//     feed (TriageObserver): no selection shows MINE (ball_in_court == mine);
//     a selected source shows that source's items. Rows are selectable
//     (List(selection:)) and drive the detail pane.
//   • detail pane — renders the selected TriageItem via TriageDetailView
//     (Core spine + per-family body), or a "Select an item" empty state
//     (READ-ONLY: the only action is "Open in source" via Core.url).
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
    /// Live `/triage` feed driving the middle + detail panes (the sidebar still
    /// reads `observer` / `/sources`). Bug-2 (middle list reacts to the sidebar
    /// selection) + bug-3 (detail renders the selected item) are both resolved
    /// against this feed.
    @StateObject private var triage: TriageObserver
    /// Sidebar selection (nil = MINE / Ball-in-court view). Bound to the sidebar
    /// `List(selection:)` AND read by the middle pane — fixes bug 2.
    @State private var selectedSourceID: String?
    /// Middle-list selection — bound to the middle `List(selection:)` and
    /// resolved into a `TriageItem` for the detail pane — fixes bug 3.
    @State private var selectedItemID: String?
    /// Sidebar sort order (applied WITHIN each section — Triage + Sources).
    /// Default alpha (case-insensitive `displayName`); itemCount sorts by the
    /// pill count descending (most first).
    @State private var sortMode: SortMode = .alpha

    /// How the sidebar source rows are ordered within each section.
    enum SortMode: String, CaseIterable, Identifiable {
        case alpha
        case itemCount
        var id: String { rawValue }
        var label: String { self == .alpha ? "Name" : "Count" }
    }

    /// Default-constructs its own observers (the live path). `View` body /
    /// property init runs on the main actor, so the @MainActor-isolated
    /// observers are reachable here. The `#Preview` injects mock-seeded
    /// observers via the explicit initializer.
    init() {
        _observer = StateObject(wrappedValue: SourceIndexObserver())
        _triage = StateObject(wrappedValue: TriageObserver())
    }

    /// Injection seam for previews / tests (mock-seeded observers).
    init(observer: SourceIndexObserver, triage: TriageObserver = TriageObserver()) {
        _observer = StateObject(wrappedValue: observer)
        _triage = StateObject(wrappedValue: triage)
    }

    var body: some View {
        // HSplitView (not NavigationSplitView) — this view is mounted as the
        // `detail` of AppNavigation's OWN NavigationSplitView. A NESTED
        // NavigationSplitView does NOT expand to fill its parent's detail pane
        // (its columns collapse to intrinsic widths, leaving a dead gap on the
        // right). HSplitView is the established multi-pane-detail pattern inside
        // AppNavigation (see SessionsView) — it fills the parent edge-to-edge
        // and provides resizable dividers (bug 1).
        HSplitView {
            sidebar
                // Sidebar keeps a max cap so it stays a true sidebar column.
                .frame(minWidth: 220, idealWidth: 248, maxWidth: 300, maxHeight: .infinity)
            contentPane
                // CAPPED: the source-items list is bounded so it never grabs
                // more than ~420pt — the detail pane absorbs the remaining width.
                .frame(minWidth: 300, idealWidth: 360, maxWidth: 420, maxHeight: .infinity)
            detailPane
                // Flexible: takes ALL remaining width after sidebar + list caps.
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("Sources")
        .accessibilityIdentifier("source-index-view")
        .task {
            observer.startPolling()
            triage.startPolling()
        }
        // Clear the item selection whenever the source filter changes, so a
        // stale detail from the previous source never lingers.
        .onChange(of: selectedSourceID) { _, _ in selectedItemID = nil }
        .onDisappear {
            observer.stopPolling()
            triage.stopPolling()
        }
    }

    // MARK: - Middle-pane data (driven by the sidebar selection)

    /// The triage items shown in the middle list: MINE when no source is
    /// selected, else that source's items. THIS is the binding that makes the
    /// middle list react to the sidebar (bug 2).
    private var contentItems: [TriageItem] {
        if let sourceID = selectedSourceID {
            // Namespace-aware: the sidebar id is the BARE registry name ("gmail"),
            // but multi-account sources stamp item.source as account-namespaced
            // ("gmail:personal"/"gmail:priceless"). Match the bare id OR any
            // "<id>:<account>" variant. Bare sources still match exactly.
            return triage.items.filter {
                $0.source == sourceID || $0.source.hasPrefix(sourceID + ":")
            }
        }
        return triage.mine
    }

    /// Header title for the middle pane — the selected source's display name,
    /// or "Ball in Court" for the MINE view.
    private var contentTitle: String {
        guard let sourceID = selectedSourceID else { return "Ball in Court" }
        return observer.index.sources.first { $0.id == sourceID }?.displayName ?? sourceID
    }

    private var contentSubtitle: String {
        let n = contentItems.count
        let noun = n == 1 ? "item" : "items"
        if selectedSourceID == nil {
            return "\(n) \(noun) where ball_in_court == MINE · all aggregated sources"
        }
        return "\(n) \(noun)"
    }

    /// Resolve the middle-list selection into a full TriageItem for the detail
    /// pane (bug 3). Scoped to the currently-shown items so a selection can
    /// never resolve to an item outside the visible list.
    private var selectedItem: TriageItem? {
        guard let id = selectedItemID else { return nil }
        return contentItems.first { $0.id == id }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            sortHeader
            Divider()
            sidebarList
        }
    }

    /// Inline sort control above the List. A `Menu` button (NOT a `.toolbar` —
    /// this view is nested in AppNavigation's detail, where a toolbar attaches
    /// oddly) toggling alpha ⇄ itemCount, default alpha.
    private var sortHeader: some View {
        HStack(spacing: 6) {
            Text("Sort")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("Sort", selection: $sortMode) {
                ForEach(SortMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .accessibilityIdentifier("source-index-sort-picker")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var sidebarList: some View {
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
        let rows = sorted(observer.index.aggregatedSources)
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
        let rows = sorted(observer.index.ownSurfaceSources)
        if !rows.isEmpty {
            Section("Sources") {
                ForEach(rows) { source in
                    SourceSidebarRow(source: source)
                        .tag(source.id)
                }
            }
        }
    }

    /// Sort source rows WITHIN a section by the active `sortMode`:
    /// `.alpha` → `displayName` case-insensitive ascending; `.itemCount` → the
    /// count shown in the pill (mineCount for aggregated, itemCount for
    /// own-surface) DESCENDING (most first). Stable tie-break on displayName.
    private func sorted(_ rows: [SourceStatus]) -> [SourceStatus] {
        switch sortMode {
        case .alpha:
            return rows.sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
        case .itemCount:
            return rows.sorted {
                let a = pillCount($0), b = pillCount($1)
                if a != b { return a > b }
                return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
        }
    }

    /// The count rendered in the row's `HealthCountPill` — mineCount for
    /// aggregated sources, itemCount for own-surface (matching the row).
    private func pillCount(_ source: SourceStatus) -> Int {
        source.inAggregate ? source.mineCount : (source.itemCount ?? 0)
    }

    // MARK: - Middle pane (selection-driven triage list)

    private var contentPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(contentTitle)
                    .font(.title2.bold())
                Text(contentSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            if contentItems.isEmpty {
                ContentUnavailableView(
                    selectedSourceID == nil ? "Nothing owed" : "No items",
                    systemImage: "tray",
                    description: Text(
                        selectedSourceID == nil
                            ? "No items are currently in your court across the aggregated sources."
                            : "This source has no items in the current feed."
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // `selection:` + per-row `.tag(item.id)` makes rows selectable
                // and drives the detail pane (bug 3).
                List(selection: $selectedItemID) {
                    ForEach(contentItems) { item in
                        TriageListRow(item: item)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                            .tag(item.id)
                    }
                }
                .listStyle(.inset)
            }

            Divider()
            statusFooter
        }
        .accessibilityIdentifier("source-index-content")
    }

    private var statusFooter: some View {
        HStack(spacing: 8) {
            if observer.index.aggregatedSources.isEmpty {
                Text("aggregate status pending")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            } else {
                // Per-source: name + a small color-coded count pill (health =
                // pill color, count = digits). No status word — the color says it.
                ForEach(observer.index.aggregatedSources) { source in
                    HStack(spacing: 3) {
                        Text(source.id)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                        FooterCountPill(health: source.health, count: source.itemCount ?? source.mineCount)
                    }
                }
            }
        }
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
        if let item = selectedItem {
            TriageDetailView(item: item)
        } else {
            ContentUnavailableView {
                Label("Select an item", systemImage: "rectangle.split.1x2")
            } description: {
                Text("Choose a triage item from the list to view its detail. The only action is \u{201C}Open in source\u{201D} via the read-only Core.url deep link.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("source-index-detail-empty")
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
            // Brand glyph to the LEFT of the name. Real SVG logo when svgl
            // ships one for the source; a neutral monogram fallback otherwise
            // (so a missing asset never blanks/crashes the row).
            BrandGlyph(sourceID: source.id, displayName: source.displayName)
            VStack(alignment: .leading, spacing: 1) {
                Text(source.displayName)
                    .font(.callout)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 10.5))
                    .foregroundStyle(subtitleColor)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            // Single color-coded pill: health = capsule color, count = digits.
            // Aggregated sources show mineCount; own-surface sources itemCount.
            // (The LIVE badge + search magnifier cues were removed — the pill
            // is now the only trailing chrome.)
            HealthCountPill(
                health: source.health,
                count: source.inAggregate ? source.mineCount : (source.itemCount ?? 0)
            )
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("source-row-\(source.id)")
    }

    /// Subtitle = "synced Xs ago" for serving rows (the produces-kind token was
    /// dropped) and the `reason` (no bare status token) for degraded /
    /// not-serving rows — the pill color conveys health.
    private var subtitle: String {
        switch source.health {
        case .degraded, .notServing:
            if let reason = source.healthReason, !reason.isEmpty {
                return reason
            }
            // No reason supplied — fall back to the synced-ago line.
            return Self.servingSubtitle(for: source)
        default:
            return Self.servingSubtitle(for: source)
        }
    }

    /// "synced Xm ago" line shown for SERVING rows (relative `lastSyncAt`).
    private static func servingSubtitle(for source: SourceStatus) -> String {
        guard let sync = source.lastSyncAt else { return "" }
        return "synced \(relative.localizedString(for: sync, relativeTo: Date()))"
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

// MARK: - Brand glyph (left-of-name source logo)

/// Renders a brand logo to the LEFT of a source name. Uses a real SVG from the
/// `BrandLogos` asset catalog (sourced from svgl.app, "Preserves Vector Data")
/// when one ships for the source, falling back to a neutral monogram tile for
/// sources svgl has no logo for (ado / snow / imessage / plaid). NSImage
/// existence is checked first so a missing asset NEVER blanks or crashes the
/// row — the monogram always renders as a guaranteed glyph.
private struct BrandGlyph: View {
    let sourceID: String
    let displayName: String
    var dim: CGFloat = 18

    var body: some View {
        if let asset = Self.brandAssetName(for: sourceID),
           NSImage(named: asset) != nil {
            Image(asset)
                .resizable()
                .scaledToFit()
                .frame(width: dim, height: dim)
                .accessibilityHidden(true)
        } else {
            // Neutral monogram fallback — rounded tile + first initial.
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.secondary.opacity(0.18))
                .frame(width: dim, height: dim)
                .overlay(
                    Text(initial)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                )
                .accessibilityHidden(true)
        }
    }

    private var initial: String {
        let s = displayName.isEmpty ? sourceID : displayName
        return String(s.prefix(1)).uppercased()
    }

    /// Map a registry source slug to its `BrandLogos.xcassets` imageset name.
    /// Returns nil for sources with no svgl logo so `BrandGlyph` renders the
    /// monogram fallback instead.
    static func brandAssetName(for sourceID: String) -> String? {
        switch sourceID {
        case "teams":            return "brand-teams"
        case "outlook",
             "outlook-calendar": return "brand-outlook"
        case "gcal":             return "brand-google-calendar"
        case "gmail":            return "brand-gmail"
        case "sessions":         return "brand-claude"
        case "health":           return "brand-apple-health"
        case "ado":              return "brand-azure"
        case "imessage":         return "brand-imessage"
        case "snow":             return "brand-servicenow"
        case "plaid":            return "brand-plaid"
        // Any unmapped source falls through to the monogram fallback.
        default:                 return nil
        }
    }
}

// MARK: - Triage list row (middle pane, selectable)

// Redesigned per docs/nx-ui/nx-detail-redesign.html (LIST column): the SUBJECT
// leads (bold) with a relative time trailing; the author shows ONCE plus a
// message preview (summary) as secondary; the blue leading bar marks ONLY rows
// where ball_in_court == mine; the per-row source/kind stamp is DROPPED (the
// column header already names the source).
private struct TriageListRow: View {
    let item: TriageItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Blue leading bar ONLY for "in your court" rows; transparent
            // otherwise (keeps the text aligned across rows).
            RoundedRectangle(cornerRadius: 2)
                .fill(item.ballInCourt == .mine ? Color.blue : Color.clear)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                // L1: subject leads (bold) + relative time trailing.
                HStack(alignment: .firstTextBaseline) {
                    Text(item.title.isEmpty ? "(untitled)" : item.title)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let ts = item.lastActivityAt ?? item.createdAt {
                        Text(Self.relative.localizedString(for: ts, relativeTo: Date()))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                // L2: author ONCE + message preview (summary) as secondary.
                HStack(spacing: 5) {
                    if let who = item.author?.displayName, !who.isEmpty {
                        Text(who)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    if let preview = item.payload.comms?.summary, !preview.isEmpty {
                        Text("· \(preview)")
                            .font(.system(size: 12))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .accessibilityIdentifier("triage-row-\(item.id)")
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
}

// MARK: - Shared chrome

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

/// Color-coded count pill: the capsule background encodes source HEALTH
/// (serving→green, degraded→orange, notServing→red, unknown→gray) and the
/// monospaced-digit text is the COUNT. Unifies the old HealthDot + count badge
/// into one badge — the color now conveys health, so no status word is needed.
private struct HealthCountPill: View {
    let health: SourceHealth
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.system(size: 11, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Self.color(for: health), in: Capsule())
            .accessibilityLabel("\(count) items, \(health.footerToken)")
    }

    static func color(for health: SourceHealth) -> Color {
        switch health {
        case .serving:    return .green
        case .degraded:   return .orange
        case .notServing: return .red
        case .unknown:    return .gray
        }
    }
}

/// Compact footer variant of the color-coded count pill (smaller type/padding
/// to sit on the one-line CLI-style status footer). Same color logic.
private struct FooterCountPill: View {
    let health: SourceHealth
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.system(size: 9, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(HealthCountPill.color(for: health), in: Capsule())
            .accessibilityLabel("\(count) items, \(health.footerToken)")
    }
}

// MARK: - Universal triage detail (macOS-native; mirrors iOS DetailScene)
//
// macOS-native equivalent of nexus-ios/Sources/Scenes/DetailScene.swift. The
// iOS chrome (BallChip / OutlinePill / PriorityChip / Avatar / KindGlyph /
// TriageFormat) is internal to the nexus-ios target and not reachable from this
// macOS target, so this view + its small local chrome mirror that logic rather
// than importing it. READ-ONLY: the only action is the Core.url deep link.

// Redesigned per docs/nx-ui/nx-detail-redesign.html. For comms-kind items
// (email / chat / ticket / work_item / code_review) the layout is, top-to-bottom:
// STATUS BANNER → IDENTITY HEADER → CONVERSATION THREAD → "WHY IT'S HERE" callout
// → COMPACT METADATA row → ACTIONS. Non-comms payloads (calendar / finance /
// health / session) keep their existing per-family body render under the same
// header + actions chrome. READ-ONLY: the only mutations are local (copy) or a
// hand-off (Open in source via Core.url).
struct TriageDetailView: View {
    let item: TriageItem

    /// Whether to show the conversation thread (comms families only).
    private var isComms: Bool {
        switch item.kind {
        case .email, .chatMessage, .ticket, .workItem, .codeReview: return true
        default: return false
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                StatusBanner(item: item)

                identityHeader
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 4)

                if isComms {
                    ConversationThread(item: item)
                        .padding(.horizontal, 20)
                        .padding(.top, 14)
                    whyCallout
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                } else {
                    // Non-comms payloads keep their structured per-family body.
                    payloadBody
                        .padding(.horizontal, 20)
                        .padding(.top, 14)
                }

                compactMetadata
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
            }
        }
        .safeAreaInset(edge: .bottom) { actionsBar }
        .navigationTitle(item.title.isEmpty ? "Detail" : item.title)
        .accessibilityIdentifier("triage-detail-view")
    }

    // MARK: Identity header (one line: avatar + author + source + relative time)

    private var identityHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            DetailAvatar(name: item.author?.displayName ?? item.source)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title.isEmpty ? "(untitled)" : item.title)
                    .font(.system(size: 18, weight: .bold))
                    .lineLimit(2)
                HStack(spacing: 7) {
                    BrandGlyph(sourceID: item.source, displayName: item.source, dim: 14)
                    Text(item.source.capitalized)
                        .foregroundStyle(.secondary)
                    if let who = item.author?.displayName, !who.isEmpty {
                        Text("· \(who)").foregroundStyle(.secondary)
                    }
                    if let ts = item.lastActivityAt ?? item.createdAt {
                        Text("· \(Self.ago(ts))").foregroundStyle(.secondary)
                    }
                }
                .font(.system(size: 12))
                .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("detail-identity-header")
    }

    // MARK: "Why it's here" callout (disposition_evidence, fallback summary)

    @ViewBuilder
    private var whyCallout: some View {
        if let why = item.payload.comms?.dispositionEvidence ?? item.payload.comms?.summary,
           !why.isEmpty {
            HStack(alignment: .top, spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.gray.opacity(0.6))
                    .frame(width: 3)
                (Text("Why it's here:  ").font(.system(size: 12.5, weight: .semibold))
                    + Text(why).font(.system(size: 12.5).italic()))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 11)
            }
            .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier("detail-why-callout")
        }
    }

    // MARK: Compact metadata row (only NON-empty values)

    private var compactMetadata: some View {
        let parts = item.participants.isEmpty
            ? nil
            : item.participants.map(\.displayName).joined(separator: ", ")
        return VStack(alignment: .leading, spacing: 0) {
            Divider().padding(.bottom, 12)
            // Wrapping flow of "Label value" chips — only filled values appear.
            FlowMetaRow {
                if let parts { MetaKV(label: "Participants", value: parts) }
                if let created = item.createdAt { MetaKV(label: "Started", value: Self.ago(created)) }
                if let last = item.lastActivityAt { MetaKV(label: "Last activity", value: Self.ago(last)) }
                if !item.stillPresentUpstream {
                    MetaKV(label: "Upstream", value: "may be resolved · last seen \(Self.ago(item.lastSeenAt))")
                }
            }
        }
        .accessibilityIdentifier("detail-meta-row")
    }

    // MARK: Actions bar (primary Open in source + Copy link / Copy text)

    private var actionsBar: some View {
        HStack(spacing: 10) {
            if let url = item.url, let link = URL(string: url) {
                Link(destination: link) {
                    HStack(spacing: 7) {
                        BrandGlyph(sourceID: item.source, displayName: item.source, dim: 15)
                        Text("Open in \(item.source.capitalized)")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.blue, in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("detail-open-in-source")

                Button("Copy link") {
                    copyToPasteboard(url)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("detail-copy-link")
            }
            Button("Copy text") {
                copyToPasteboard(copyableText)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("detail-copy-text")

            Spacer(minLength: 0)
            Text("↵ open · ⌘C copy")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(.bar)
        .overlay(Divider(), alignment: .top)
    }

    private var copyableText: String {
        let lines = [item.title, item.payload.comms?.summary, item.payload.comms?.body]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return lines.joined(separator: "\n\n")
    }

    private func copyToPasteboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    // MARK: Non-comms payload body (calendar / finance / health / session)

    @ViewBuilder
    private var payloadBody: some View {
        List {
            switch item.payload {
            case .calendar(let b): calendarBody(b)
            case .finance(let b):  financeBody(b)
            case .health(let b):   healthBody(b)
            case .session(let b):  sessionBody(b)
            case .medication(let b): medicationBody(b)
            case .comms, .unknown: EmptyView()
            }
        }
        .listStyle(.inset)
        .frame(minHeight: 280)
        .scrollDisabled(true)
    }

    @ViewBuilder
    private func calendarBody(_ b: CalendarBody) -> some View {
        Section("Event") {
            if b.allDay {
                LabeledContent("When", value: "All-day · \(b.startDate ?? "")")
            } else {
                LabeledContent("When", value: Self.timeRange(b.startTime, b.endTime))
            }
            if let loc = b.location { LabeledContent("Location", value: loc) }
            if let rsvp = b.selfResponseStatus { LabeledContent("Your RSVP", value: rsvp) }
            if let status = b.eventStatus, status.lowercased() == "cancelled" {
                Label("Cancelled", systemImage: "xmark.circle").foregroundStyle(.red)
            }
            if !b.recurrenceRules.isEmpty {
                Label("Recurring", systemImage: "repeat").font(.caption).foregroundStyle(.secondary)
            }
            if let url = b.conferenceUrl, let link = URL(string: url) {
                Link(destination: link) { Label("Join", systemImage: "video") }
            }
        }
        if !b.attendees.isEmpty {
            Section("Attendees") {
                ForEach(b.attendees) { a in
                    HStack {
                        Text(a.displayName ?? a.email)
                        if a.isSelf { DetailPill(text: "you", tint: .blue) }
                        if a.organizer { DetailPill(text: "organizer") }
                        Spacer()
                        Text(a.responseStatus ?? "—").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func financeBody(_ b: FinanceBody) -> some View {
        Section("Transaction") {
            LabeledContent("Amount") {
                Text(Self.amount(b))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(b.isInflow ? .green : .primary)
            }
            if let m = b.merchantName { LabeledContent("Merchant", value: m) }
            if let c = b.categoryPrimary { LabeledContent("Category", value: c) }
            if b.pending { DetailPill(text: "pending", tint: .orange) }
            if let acct = b.accountName {
                LabeledContent("Account", value: "\(acct) ••••\(b.accountMask ?? "")")
            }
            if let inst = b.institution { LabeledContent("Institution", value: inst) }
        }
    }

    @ViewBuilder
    private func healthBody(_ b: HealthBody) -> some View {
        Section("Metric") {
            LabeledContent("Value") {
                Text("\(Self.trim(b.value)) \(b.unit)")
                    .font(.body.monospacedDigit())
            }
            if let mn = b.min, let avg = b.avg, let mx = b.max {
                LabeledContent("min / avg / max",
                               value: "\(Self.trim(mn)) / \(Self.trim(avg)) / \(Self.trim(mx))")
            }
            if let dev = b.sourceDevice { LabeledContent("Device", value: dev) }
            if let s = b.periodStart, let e = b.periodEnd {
                LabeledContent("Window", value: "\(Self.ago(s)) … \(Self.ago(e))")
            }
            if let reason = b.anomalyReason {
                Label(reason, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private func sessionBody(_ b: SessionBody) -> some View {
        Section("Session") {
            LabeledContent("Status", value: b.status)
            if let st = b.agentState { LabeledContent("Agent state", value: st) }
            if let m = b.machine { LabeledContent("Machine", value: m) }
            if let model = b.model { LabeledContent("Model", value: model) }
            if let br = b.branch { LabeledContent("Branch", value: br) }
            if let cost = b.totalCostUsd {
                LabeledContent("Cost") {
                    Text(String(format: "$%.2f", cost)).font(.body.monospacedDigit())
                }
            }
            if let spec = b.spec { LabeledContent("Spec", value: spec) }
        }
    }

    @ViewBuilder
    private func medicationBody(_ b: MedicationBody) -> some View {
        Section("Medication") {
            LabeledContent("Name", value: b.medicationName)
            LabeledContent("Status") {
                if b.isMissed {
                    Label(b.status, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                } else {
                    Text(b.status)
                }
            }
            if let g = b.group { LabeledContent("Group", value: g) }
            if let dose = b.dose {
                LabeledContent("Dose", value: "\(dose)\(b.unit.map { " \($0)" } ?? "")")
            }
            if let st = b.scheduledTime { LabeledContent("Scheduled", value: Self.ago(st)) }
            if let lt = b.loggedTime { LabeledContent("Logged", value: Self.ago(lt)) }
        }
    }

    // MARK: Local formatting (mirrors TriageFormat / FinanceFormat)

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func ago(_ date: Date?) -> String {
        guard let date else { return "—" }
        return relative.localizedString(for: date, relativeTo: Date())
    }

    static func timeRange(_ start: Date?, _ end: Date?) -> String {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        switch (start, end) {
        case let (s?, e?):  return "\(f.string(from: s))–\(f.string(from: e))"
        case let (s?, nil): return f.string(from: s)
        default:            return ""
        }
    }

    static func amount(_ b: FinanceBody) -> String {
        let mag = abs(b.amount)
        let sign = b.isInflow ? "+" : "−"
        return String(format: "%@$%.2f", sign, mag)
    }

    static func trim(_ v: Double) -> String {
        if v == v.rounded() { return String(Int(v)) }
        return String(format: "%.1f", v)
    }
}

// MARK: - Detail chrome (macOS-local; mirrors iOS TriageShared)

private struct DetailPill: View {
    let text: String
    var tint: Color = .secondary
    var filled: Bool = false

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(filled ? Color.white : tint)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background {
                if filled {
                    RoundedRectangle(cornerRadius: 4).fill(tint)
                } else {
                    RoundedRectangle(cornerRadius: 4).stroke(tint.opacity(0.5), lineWidth: 1)
                }
            }
    }
}

// MARK: - Status banner (disposition-driven; first thing the eye lands on)

/// Color + label by the comms disposition / ball-in-court (per the redesign):
/// resolved → green "Likely resolved — no action needed", inbox/mine → blue
/// "Your move", waiting → gray "Waiting on them", open → blue. Non-comms items
/// fall back to the ball-in-court read.
private struct StatusBanner: View {
    let item: TriageItem

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: spec.symbol)
                .font(.system(size: 13, weight: .bold))
            Text(spec.label)
                .font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
        }
        .foregroundStyle(spec.tint)
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(spec.tint.opacity(0.14))
        .overlay(Divider(), alignment: .bottom)
        .accessibilityIdentifier("detail-status-banner")
        .accessibilityLabel(spec.label)
    }

    private struct Spec { let label: String; let symbol: String; let tint: Color }

    private var spec: Spec {
        if let d = item.payload.comms?.suggestedDisposition {
            switch d {
            case .resolved:
                return Spec(label: "Likely resolved — no action needed", symbol: "checkmark", tint: .green)
            case .waiting:
                return Spec(label: "Waiting on them", symbol: "hourglass", tint: .gray)
            case .inbox, .open:
                return item.ballInCourt == .mine
                    ? Spec(label: "Your move", symbol: "arrow.turn.up.right", tint: .blue)
                    : Spec(label: "Open", symbol: "tray", tint: .blue)
            }
        }
        // Non-comms: read off ball-in-court.
        switch item.ballInCourt {
        case .mine:    return Spec(label: "Your move", symbol: "arrow.turn.up.right", tint: .blue)
        case .theirs:  return Spec(label: "Waiting on them", symbol: "hourglass", tint: .gray)
        case .unclear: return Spec(label: "Needs a look", symbol: "questionmark.circle", tint: .blue)
        }
    }
}

// MARK: - Conversation thread (on-demand /thread fetch -> message bubbles)

/// Fetches the item's thread on appear (and on item change) via
/// `NexusClient.fetchThread`, rendering message bubbles: incoming = gray
/// leading, outgoing (`self`) = blue trailing. Loading + empty states. A
/// "View earlier in <source>" deep-link (Core.url) sits at the top. Renders
/// ANY source's messages — independent of Stage 2.
private struct ConversationThread: View {
    let item: TriageItem

    @State private var messages: [CommsMessage] = []
    @State private var phase: Phase = .loading

    private enum Phase: Equatable { case loading, loaded, empty }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text("Conversation")
                .font(.system(size: 10.5, weight: .semibold))
                .kerning(0.6)
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)

            switch phase {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading conversation…").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("detail-thread-loading")
            case .empty:
                Text("No earlier messages available for this item.")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("detail-thread-empty")
            case .loaded:
                if let url = item.url, let link = URL(string: url) {
                    Link(destination: link) {
                        Text("View earlier in \(item.source.capitalized) →")
                            .font(.system(size: 12))
                            .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("detail-thread-earlier-link")
                }
                ForEach(messages) { msg in
                    MessageBubble(message: msg)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("detail-conversation-thread")
        .task(id: item.id) { await load() }
    }

    private func load() async {
        phase = .loading
        // Qualify: the nexus-mac target compiles its OWN pre-XcodeGen
        // `nexus/nexus/NexusClient.swift` (an actor without /thread), so an
        // unqualified `NexusClient()` would resolve to that one. Use the
        // NexusShared client that carries `fetchThread`.
        let client = NexusShared.NexusClient()
        let result = (try? await client.fetchThread(source: item.source, id: item.id)) ?? []
        messages = result
        phase = result.isEmpty ? .empty : .loaded
    }
}

/// One conversation bubble. `self` (outgoing) renders blue + trailing; incoming
/// renders gray + leading, both with the sender name + relative time.
private struct MessageBubble: View {
    let message: CommsMessage

    var body: some View {
        HStack {
            if message.isSelf { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                Text(message.isSelf ? "You" : message.author)
                    .font(.system(size: 10.5))
                    .foregroundStyle(message.isSelf ? Color.white.opacity(0.75) : .secondary)
                Text(message.text)
                    .font(.system(size: 13.5))
                    .foregroundStyle(message.isSelf ? .white : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let ts = message.ts {
                    Text(Self.relative.localizedString(for: ts, relativeTo: Date()))
                        .font(.system(size: 9.5))
                        .foregroundStyle(message.isSelf ? Color.white.opacity(0.55) : Color.secondary)
                        .frame(maxWidth: .infinity, alignment: message.isSelf ? .trailing : .leading)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(
                message.isSelf ? Color.blue : Color.secondary.opacity(0.16),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .frame(maxWidth: 360, alignment: message.isSelf ? .trailing : .leading)
            if !message.isSelf { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.isSelf ? "You" : message.author): \(message.text)")
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
}

// MARK: - Detail avatar (initials monogram)

private struct DetailAvatar: View {
    let name: String

    var body: some View {
        Text(monogram)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 38, height: 38)
            .background(
                LinearGradient(colors: [Color(white: 0.36), Color(white: 0.28)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: Circle()
            )
            .accessibilityHidden(true)
    }

    private var monogram: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }.joined().uppercased()
        return letters.isEmpty ? "?" : letters
    }
}

// MARK: - Compact metadata chip + wrapping row

private struct MetaKV: View {
    let label: String
    let value: String

    var body: some View {
        (Text("\(label)  ").font(.system(size: 12)).foregroundStyle(.tertiary)
            + Text(value).font(.system(size: 12)).foregroundStyle(.secondary))
            .lineLimit(1)
    }
}

/// Minimal wrapping layout for the metadata chips (only filled values are
/// passed in, so empties are suppressed before this ever sees them).
private struct FlowMetaRow: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        let hGap: CGFloat = 18, vGap: CGFloat = 6
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if x > 0, x + s.width > maxWidth { x = 0; y += rowH + vGap; rowH = 0 }
            x += s.width + hGap
            rowH = max(rowH, s.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        let hGap: CGFloat = 18, vGap: CGFloat = 6
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { x = bounds.minX; y += rowH + vGap; rowH = 0 }
            sv.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + hGap
            rowH = max(rowH, s.height)
        }
    }
}

// MARK: - Preview (mock data — endpoint unshipped)

#if DEBUG
#Preview("Source Index (mock)") {
    SourceIndexView(observer: .preview, triage: .previewTriage)
        .frame(width: 1040, height: 660)
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

extension TriageObserver {
    /// Sample triage feed for the middle + detail panes in `#Preview`.
    static var previewTriage: TriageObserver {
        let obs = TriageObserver()
        obs.setItemsForPreview(TriageItem.sampleData, isSample: true)
        return obs
    }
}
#endif
