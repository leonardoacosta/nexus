// NotificationDetailScene — full untruncated notification (mx-rkir.9).
//
// iOS banners truncate the body; this subview renders the FULL title and
// body so Leo can read the whole notification in-app. Selectable, scrollable
// text plus the metadata (project, session, timestamp, severity).
//
// "Open session": NotificationEvent carries NO sessionId in the wire contract
// (see Notification.swift — only sessionName / project / channel). We resolve
// the live session by matching the notification's sessionName against the
// observer's sessions (`tmuxSession`, the same field the Sessions tab uses for
// its name subtitle). When a match exists we surface an "Open session" button
// that sets `navigation.attachingSessionId`, reusing RootScene's single
// AttachScene `.sheet` (mx-rkir.3/.7) to open the live PTY. When no session
// matches, the button is omitted — we do NOT invent a sessionId.

import SwiftUI
import NexusShared

struct NotificationDetailScene: View {
    let event: NotificationEvent

    @EnvironmentObject private var observer: SessionObserver
    @EnvironmentObject private var navigation: NavigationState
    @Environment(\.dismiss) private var dismiss

    /// Resolve the live session id from the notification's sessionName by
    /// matching the Session model's `tmuxSession` (the human session name the
    /// Sessions tab renders). Returns nil when the notification has no session
    /// name or no live session matches — in which case "Open session" is hidden.
    private var resolvedSessionId: String? {
        guard let name = event.sessionName, !name.isEmpty else { return nil }
        return observer.sessions.first { $0.tmuxSession == name }?.id
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let emoji = event.emoji, !emoji.isEmpty {
                    Text(emoji).font(.largeTitle)
                }

                Text(event.title ?? "Notification")
                    .font(.title2.bold())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("notification-detail-title")

                Text(event.body)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("notification-detail-body")

                // Optional structured bullet items (reaper-style summaries).
                if let items = event.items, !items.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(items, id: \.self) { item in
                            Text("• \(item)")
                                .font(.callout)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Divider()

                metadata

                if let sessionId = resolvedSessionId {
                    Button {
                        // Reuse RootScene's existing AttachScene sheet
                        // (mx-rkir.3/.7) — set the binding and dismiss this
                        // pushed detail so the sheet presents over the tab.
                        navigation.attachingSessionId = sessionId
                        dismiss()
                    } label: {
                        Label("Open session", systemImage: "terminal")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("notification-detail-open-session")
                }
            }
            .padding()
        }
        .navigationTitle("Notification")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("notification-detail")
    }

    private var metadata: some View {
        VStack(alignment: .leading, spacing: 8) {
            metaRow("Time", event.receivedAt.formatted(date: .abbreviated, time: .standard))
            if let s = event.sessionName, !s.isEmpty { metaRow("Session", s) }
            if let p = event.project, !p.isEmpty { metaRow("Project", p) }
            if let c = event.channel, !c.isEmpty { metaRow("Channel", c) }
            metaRow("Severity", event.severity.rawValue)
        }
        .font(.callout)
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

#Preview {
    NavigationStack {
        NotificationDetailScene(event: NotificationEvent(
            body: "The reaper completed. Found 3 bloat candidates across the monorepo and archived 2 stale branches.",
            title: "Weekly reaper done",
            emoji: "🧹",
            project: "mx",
            severity: .info,
            items: ["packages/old-thing (unused)", "apps/legacy (dead)"],
            sessionName: "mx-main"
        ))
        .environmentObject(SessionObserver())
        .environmentObject(NavigationState())
    }
}
