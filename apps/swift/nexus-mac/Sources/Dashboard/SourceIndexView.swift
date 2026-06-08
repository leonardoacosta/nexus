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
            return triage.items.filter { $0.source == sourceID }
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
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(source.displayName)
                        .font(.callout)
                        .lineLimit(1)
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
            // Single color-coded pill: health = capsule color, count = digits.
            // Aggregated sources show mineCount; own-surface sources itemCount.
            HealthCountPill(
                health: source.health,
                count: source.inAggregate ? source.mineCount : (source.itemCount ?? 0)
            )
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("source-row-\(source.id)")
    }

    /// Subtitle keeps the kind · synced-ago line for serving rows and the
    /// reason (no bare status token) for degraded / not-serving rows — the
    /// pill color now conveys health.
    private var subtitle: String {
        switch source.health {
        case .degraded, .notServing:
            if let reason = source.healthReason, !reason.isEmpty {
                return reason
            }
            // No reason supplied — fall back to the kind/sync line.
            return Self.servingSubtitle(for: source)
        default:
            return Self.servingSubtitle(for: source)
        }
    }

    /// "kind · synced Xm ago" line shown for SERVING rows.
    private static func servingSubtitle(for source: SourceStatus) -> String {
        var parts: [String] = []
        if let kind = source.producesKind, !kind.isEmpty { parts.append(kind) }
        if let sync = source.lastSyncAt {
            parts.append("synced \(relative.localizedString(for: sync, relativeTo: Date()))")
        }
        return parts.joined(separator: " · ")
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

// MARK: - Triage list row (middle pane, selectable)

private struct TriageListRow: View {
    let item: TriageItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(lineColor)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(item.author?.displayName ?? "—")
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let ts = item.lastActivityAt ?? item.createdAt {
                        Text(Self.relative.localizedString(for: ts, relativeTo: Date()))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(item.title.isEmpty ? "(untitled)" : item.title)
                    .font(.system(size: 13))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(item.source)
                        .font(.system(size: 10, weight: .semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
                    Text(item.kind.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityIdentifier("triage-row-\(item.id)")
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

struct TriageDetailView: View {
    let item: TriageItem

    var body: some View {
        List {
            coreSection
            payloadSection
            if let url = item.url, let link = URL(string: url) {
                Section {
                    Link(destination: link) {
                        Label("Open in \(item.source)", systemImage: "arrow.up.right.square")
                    }
                    .accessibilityIdentifier("detail-open-in-source")
                }
            }
        }
        .listStyle(.inset)
        .navigationTitle(item.title.isEmpty ? "Detail" : item.title)
        .accessibilityIdentifier("triage-detail-view")
    }

    // MARK: Core spine (always)

    private var coreSection: some View {
        Section("Core") {
            HStack(spacing: 8) {
                Image(systemName: DetailGlyph.symbol(for: item.kind))
                    .foregroundStyle(.blue)
                Text("\(item.source.uppercased()) · \(item.kind.rawValue)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(item.title.isEmpty ? "(untitled)" : item.title)
                .font(.headline)

            HStack {
                Text("Ball in court").foregroundStyle(.secondary)
                Spacer()
                DetailBallChip(ball: item.ballInCourt)
            }

            if let author = item.author {
                LabeledContent("Author") {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(author.displayName)
                        if let h = author.handle {
                            Text(h).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !item.participants.isEmpty {
                LabeledContent("Participants",
                               value: item.participants.map(\.displayName).joined(separator: ", "))
                    .lineLimit(2)
            }
            if let created = item.createdAt {
                LabeledContent("Created", value: Self.ago(created))
            }
            if let last = item.lastActivityAt {
                LabeledContent("Last activity", value: Self.ago(last))
            }
            if !item.stillPresentUpstream {
                Label(
                    "May have been resolved upstream — last seen \(Self.ago(item.lastSeenAt))",
                    systemImage: "clock.arrow.circlepath"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
        }
    }

    // MARK: Payload body (varies by case)

    @ViewBuilder
    private var payloadSection: some View {
        switch item.payload {
        case .comms(let b):    commsBody(b)
        case .calendar(let b): calendarBody(b)
        case .finance(let b):  financeBody(b)
        case .health(let b):   healthBody(b)
        case .session(let b):  sessionBody(b)
        case .unknown:         EmptyView()
        }
    }

    @ViewBuilder
    private func commsBody(_ b: CommsBody) -> some View {
        Section("Message") {
            if let s = b.summary { Text(s) }
            if let body = b.body, body != b.summary {
                Text(body).font(.callout).foregroundStyle(.secondary)
            }
            HStack {
                if b.priority != .normal && b.priority != .low {
                    DetailPill(text: b.priority.label, tint: b.priority == .urgent ? .red : .orange, filled: true)
                }
                DetailPill(text: b.suggestedDisposition.label, tint: .blue)
                if let up = b.upstreamState { DetailPill(text: up) }
            }
            if let ev = b.dispositionEvidence {
                Label(ev, systemImage: "lightbulb")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
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

private enum DetailGlyph {
    static func symbol(for kind: TriageKind) -> String {
        switch kind {
        case .email:         return "envelope"
        case .chatMessage:   return "bubble.left.and.bubble.right"
        case .ticket:        return "ticket"
        case .workItem:      return "checklist"
        case .codeReview:    return "arrow.triangle.pull"
        case .calendarEvent: return "calendar"
        case .financeTxn:    return "creditcard"
        case .healthMetric:  return "heart"
        case .codeSession:   return "terminal"
        default:             return "circle"
        }
    }
}

private struct DetailBallChip: View {
    let ball: BallInCourt

    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color, in: Capsule())
            .accessibilityLabel("ball in court \(label)")
    }

    private var label: String {
        switch ball {
        case .mine:    return "MINE"
        case .theirs:  return "THEIRS"
        case .unclear: return "UNCLEAR"
        }
    }

    private var color: Color {
        switch ball {
        case .mine:    return .blue
        case .theirs:  return .gray
        case .unclear: return .orange
        }
    }
}

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
