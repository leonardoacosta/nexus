// SessionsView — macOS dashboard parity for apps/nextjs/src/app/session.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.2)
//       openspec/changes/session-attach-and-cwd-cap (tasks 2.4, 2.5, 2.6)
//
// NexusShared-based replacement for the legacy SessionList. Binds to a
// `SessionObserver` (cross-platform observer that consumes /sessions +
// the agent SSE stream) so the same code can be reused on iOS. Managed
// sessions render as tappable Buttons that open a PTY pane in the
// trailing column of an HSplitView; non-managed sessions render
// read-only with a muted "untracked" badge.

import SwiftUI
import NexusShared

@MainActor
struct SessionsView: View {
    @StateObject private var observer: SessionObserver

    /// True when this view owns the observer's lifecycle (standalone /
    /// iOS use). False when an outer scene injected a shared observer
    /// (nexus-mac dashboard) — then the scene root drives start/stop and
    /// this view must NOT stop streams on disappear, or navigating away
    /// from the Sessions tab would silently kill the shared poll/SSE
    /// for every other tab (bd:nx-t9wrj).
    private let ownsLifecycle: Bool

    /// Currently-selected managed session id. Nil → no PTY pane shown,
    /// list takes full width. Non-managed rows can never set this.
    @State private var selectedSessionId: String?

    /// Transient "session ended" toast shown when a tap-handler observes
    /// that the selected row's id is no longer in the most recent
    /// /sessions fetch (e.g. agent restarted between render and tap).
    /// Self-clears after `staleToastDurationSeconds`.
    @State private var staleSessionToast: String?
    private let staleToastDurationSeconds: UInt64 = 3

    public init() {
        _observer = StateObject(wrappedValue: SessionObserver())
        ownsLifecycle = true
    }

    public init(observer: SessionObserver) {
        _observer = StateObject(wrappedValue: observer)
        ownsLifecycle = false
    }

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 8) {
                header
                if let toast = staleSessionToast {
                    staleToast(toast)
                }
                if observer.activeSessions.isEmpty {
                    emptyState
                } else {
                    listBody
                }
            }
            .padding(.vertical, 8)
            .frame(minWidth: 320, idealWidth: 420)

            if let id = selectedSessionId,
               let session = observer.activeSessions.first(where: { $0.id == id }) {
                PtyViewer(
                    sessionId: session.id,
                    sessionLabel: Session.projectLabel(for: session),
                    sessionMeta: Session.metaLine(for: session),
                    sessionType: session.sessionType,
                    onClose: { selectedSessionId = nil }
                )
                .frame(minWidth: 420)
                .accessibilityIdentifier("sessions-pty-pane")
            }
        }
        // XCUITest guard hooks (spec 2.2 + 2.4):
        //  - "sessions-view" present  ⇒ SessionsView actually mounted ⇒
        //    its .task ran ⇒ a fetch was triggered (fault #4 /
        //    bd:nx-t9wrj regression assertion).
        //  - "sessions-count:<n>" lets the transport round-trip test
        //    (2.4) observe the stub fixture rendering (0 → 1).
        .accessibilityIdentifier("sessions-view")
        .accessibilityValue("sessions-count:\(observer.activeSessions.count)")
        .task {
            // Idempotent: startStreams() guards on existing tasks, so this
            // is a harmless second call when the scene root already started
            // the shared observer.
            observer.startStreams()
            await observer.refreshSessions()
        }
        .onDisappear {
            if ownsLifecycle {
                observer.stopStreams()
            }
        }
    }

    private var header: some View {
        HStack {
            Text("SESSIONS")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Spacer()
            stateBadge
            Text("\(observer.activeSessions.count) live")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
    }

    private var stateBadge: some View {
        let color: Color = {
            switch observer.aggregateState {
            case .active:      return .green
            case .idle:        return .yellow
            case .stale:       return .orange
            case .unreachable: return .red
            }
        }()
        return Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityLabel(observer.aggregateState.accessibilityLabel)
    }

    private var emptyState: some View {
        VStack(alignment: .center, spacing: 6) {
            Text("· · ·")
                .font(.system(.title, design: .monospaced))
                .foregroundStyle(.tertiary)
            Text("no claude code on homelab")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(sortedSessions) { session in
                    sessionRow(session)
                        // Per-row hook so the 2.4 client-transport test
                        // can assert the EXACT deterministic stub fixture
                        // row (id "stub-sess-1") rendered.
                        .accessibilityIdentifier("session-row-\(session.id)")
                    Divider().padding(.leading, 14)
                }
            }
        }
    }

    /// Stable display order for the session list.
    ///
    /// 1. Active sessions first (status == "active") so the row Leo most
    ///    likely wants to tap is always at the top.
    /// 2. Then by `Session.projectLabel(for:)` (the resolved/decoded
    ///    display name) — alphabetic by what the user actually sees, not
    ///    by cwd path which leaks raw filesystem ordering.
    /// 3. Final tie-break on session id for deterministic rendering
    ///    (avoids row jitter across refetches when names collide).
    private var sortedSessions: [Session] {
        observer.activeSessions.sorted { a, b in
            if (a.status == "active") != (b.status == "active") {
                return a.status == "active"
            }
            let la = Session.projectLabel(for: a)
            let lb = Session.projectLabel(for: b)
            if la != lb { return la < lb }
            return a.id < b.id
        }
    }

    /// Managed sessions wrap the row in a `.plain` Button so the visual
    /// layout matches non-managed rows but the whole row is tappable.
    /// Tap commits the session id to selectedSessionId, which the
    /// HSplitView observes to mount PtyViewer in the trailing column.
    /// Non-managed rows render the row directly — no Button, no tap target.
    @ViewBuilder
    private func sessionRow(_ session: Session) -> some View {
        let isManaged = session.sessionType == "managed"
        let isSelected = selectedSessionId == session.id
        if isManaged {
            Button {
                handleSessionTap(session)
            } label: {
                SessionsRowView(session: session, isSelected: isSelected)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            SessionsRowView(session: session, isSelected: false)
        }
    }

    /// Verify the tapped session id still exists in the most recent
    /// `/sessions` fetch before mounting PtyViewer. Stale ids (agent
    /// restart, session ended between render + tap) fall through to a
    /// "session ended" toast + selection clear instead of opening PtyViewer
    /// in a permanent "connecting" hang (the aggregate fan-out 404s
    /// silently, so the viewer can't detect a vanished session on its own).
    private func handleSessionTap(_ session: Session) {
        let stillLive = observer.activeSessions.contains(where: { $0.id == session.id })
        if !stillLive {
            staleSessionToast = "session ended — \(Session.projectLabel(for: session))"
            selectedSessionId = nil
            let duration = staleToastDurationSeconds
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: duration * 1_000_000_000)
                staleSessionToast = nil
            }
            return
        }
        selectedSessionId = session.id
    }

    /// Inline toast banner under the header. Auto-clears after
    /// `staleToastDurationSeconds`. Render is conditional in `body` so the
    /// disappearance is a real view removal (animatable in future).
    private func staleToast(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(Color.orange.opacity(0.08))
        .accessibilityIdentifier("sessions-stale-toast")
    }
}

private struct SessionsRowView: View {
    let session: Session
    /// Highlights the currently-selected managed row so the user keeps
    /// orientation when the PTY pane mounts.
    let isSelected: Bool

    init(session: Session, isSelected: Bool = false) {
        self.session = session
        self.isSelected = isSelected
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                // TOP line: project label · branch  (primary identity)
                HStack(spacing: 6) {
                    Text(primaryLabel)
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(1)
                    if let branch = session.branch, !branch.isEmpty {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(branch)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                // BOTTOM line: model · $cost · idle/duration
                bottomLine
            }
            Spacer(minLength: 6)
            trailingColumn
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
        .contentShape(Rectangle())
    }

    /// Trailing column: status pill on top, muted `pid · originAgent` below.
    /// Non-managed sessions get an additional "untracked" badge under the
    /// meta line so users can see at a glance that the row is read-only.
    /// Right-justified, monospaced caption2 for the meta line so digits align
    /// vertically across rows.
    private var trailingColumn: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(session.status)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
            Text(metaLine)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospaced()
            if session.sessionType != "managed" {
                Text("untracked")
                    .font(.caption2.monospaced())
                    .foregroundColor(.secondary)
                    .accessibilityIdentifier("session-untracked-badge")
            }
        }
    }

    /// `pid 1234 · machine` — delegates to NexusShared's
    /// `Session.metaLine(for:)` so PTY header and row trailing column share
    /// the same fallback chain (bd:nx-dijep).
    private var metaLine: String {
        Session.metaLine(for: session)
    }

    /// model · $cost · idle/duration. Cost suppressed when null or <= 0
    /// (no `$0.00` noise on freshly-spawned sessions).
    private var bottomLine: some View {
        HStack(spacing: 6) {
            if let model = session.model, !model.isEmpty {
                Text(model)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let costText = costText {
                Text("·").foregroundStyle(.tertiary).font(.caption2)
                Text(costText)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text("·").foregroundStyle(.tertiary).font(.caption2)
            Text(timeText)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }

    /// Format `$N.NN`. Returns nil when cost is missing or non-positive so
    /// the caller can omit the entire segment (avoiding `$0.00` noise).
    private var costText: String? {
        guard let cost = session.totalCostUsd, cost > 0 else { return nil }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: cost)) ?? String(format: "$%.2f", cost)
    }

    /// `Nm idle` when idleSince is set, otherwise the running session duration
    /// `Nm` (<= 60 min) or `Nh` (> 60 min) measured from startedAt.
    private var timeText: String {
        if let idleSince = session.idleSince {
            let minutes = max(0, Int(Date().timeIntervalSince(idleSince) / 60))
            return "\(minutes)m idle"
        }
        let elapsed = max(0, Date().timeIntervalSince(session.startedAt))
        let minutes = Int(elapsed / 60)
        if minutes >= 60 {
            return "\(minutes / 60)h"
        }
        return "\(minutes)m"
    }

    /// Project-label degradation chain — delegates to NexusShared's
    /// `Session.projectLabel(for:)` so the chain is exercised by
    /// `SessionRowTests` in NexusSharedTests without coupling tests to
    /// the SwiftUI view hierarchy.
    private var primaryLabel: String {
        Session.projectLabel(for: session)
    }
}
