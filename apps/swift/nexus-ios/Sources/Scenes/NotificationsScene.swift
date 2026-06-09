// NotificationsScene — iOS list of recent notifications (mx-rkir.9).
//
// Leo's iOS banners truncate; this scene lets him read the FULL
// notification in-app. A List of recent NotificationFired rows (newest
// first) backed by SessionObserver.notifications — backfilled once from
// GET /notifications then kept live by the observer's existing SSE
// consumeNotifications loop. Tapping a row pushes NotificationDetailScene
// with the full untruncated body.
//
// Reuses the cross-platform wire model + transport: NotificationEvent,
// SessionObserver (@Published notifications), NexusAggregateClient
// .fetchNotifications(). NotificationEvent carries NO sessionId in the
// wire contract (see Notification.swift) — only sessionName / project /
// channel — so "Open session" resolves the live session by name and is
// omitted when no match exists (see NotificationDetailScene).

import SwiftUI
import NexusShared

struct NotificationsScene: View {
    @EnvironmentObject private var observer: SessionObserver

    /// Historical rows backfilled once from GET /notifications. The observer
    /// owns the LIVE list (its SSE loop prepends NotificationFired frames into
    /// `observer.notifications`); this seeds the older rows that predate the
    /// app launch. `rows` unions the two by id so neither source is lost.
    @State private var backfill: [NotificationEvent] = []

    /// Tracks whether the initial backfill fetch has completed so the
    /// empty state distinguishes "loading" from "genuinely empty".
    @State private var didLoad = false

    /// Union of the observer's live list + the REST backfill, deduped by id,
    /// newest-first. SwiftUI re-derives this whenever either source changes.
    private var rows: [NotificationEvent] {
        var seen = Set<UUID>()
        var merged: [NotificationEvent] = []
        for ev in observer.notifications + backfill where seen.insert(ev.id).inserted {
            merged.append(ev)
        }
        return merged.sorted { $0.receivedAt > $1.receivedAt }
    }

    var body: some View {
        Group {
            if rows.isEmpty {
                if didLoad {
                    ContentUnavailableView(
                        "No notifications yet",
                        systemImage: "bell.slash",
                        description: Text("Notifications appear here as they fire.")
                    )
                    .accessibilityIdentifier("notifications-empty")
                } else {
                    ProgressView("Loading notifications…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("notifications-loading")
                }
            } else {
                List(rows) { event in
                    NavigationLink {
                        NotificationDetailScene(event: event)
                    } label: {
                        NotificationRow(event: event)
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable {
                    await reload()
                }
                .accessibilityIdentifier("notifications-list")
            }
        }
        .navigationTitle("Notifications")
        .task {
            // Kick the observer's SSE + polling lifecycle (idempotent — guards
            // against double-start internally) so live NotificationFired frames
            // flow in, then backfill the historical rows once.
            observer.startStreams()
            await reload()
        }
    }

    /// Backfill the historical rows from the aggregate. The observer keeps the
    /// live SSE-fed list; this seeds the older rows on first appearance and on
    /// pull-to-refresh.
    @MainActor
    private func reload() async {
        backfill = await observer.client.fetchNotifications()
        didLoad = true
    }
}

/// Compact list row: bold title, 1–2 line body preview, project/session
/// caption + relative timestamp. Mirrors the macOS NotificationHistoryRow
/// conventions (emoji glyph, monospaced caption chips) for parity.
struct NotificationRow: View {
    let event: NotificationEvent

    private var displayTitle: String {
        if let title = event.title, !title.isEmpty { return title }
        return "Notification"
    }

    private var caption: String? {
        var parts: [String] = []
        if let s = event.sessionName, !s.isEmpty { parts.append(s) }
        if let p = event.project, !p.isEmpty { parts.append(p) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if let emoji = event.emoji, !emoji.isEmpty {
                Text(emoji).font(.title3)
            } else {
                Image(systemName: "bell.fill")
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(event.body)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let caption {
                        Text(caption)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Text(event.receivedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("notification-row-\(event.id.uuidString)")
    }
}

#Preview {
    let observer = SessionObserver()
    return NavigationStack {
        NotificationsScene()
            .environmentObject(observer)
    }
}
