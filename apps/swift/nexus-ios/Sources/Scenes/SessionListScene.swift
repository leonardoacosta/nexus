// SessionListScene — primary iOS surface listing remote CC sessions.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.3)
//
// Binds to NexusShared.SessionObserver. Tapping a row opens the detail
// pane; the "Attach" button on detail pushes AttachScene (SwiftTerm).

import SwiftUI
import NexusShared

struct SessionListScene: View {
    @EnvironmentObject private var observer: SessionObserver
    @EnvironmentObject private var navigation: NavigationState

    var body: some View {
        Group {
            if observer.activeSessions.isEmpty {
                emptyState
            } else {
                List(observer.activeSessions) { session in
                    NavigationLink(value: session.id) {
                        SessionRowView(session: session)
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable {
                    await observer.refreshSessions()
                }
            }
        }
        .navigationDestination(for: String.self) { sessionId in
            SessionDetailScene(sessionId: sessionId)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                connectionBadge
            }
        }
        .onReceive(NotificationCenter.default.publisher(
            for: .nexusOpenSessionDetail
        )) { note in
            if let id = note.object as? String {
                navigation.selectedSessionId = id
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("No active sessions")
                .font(.headline)
            Text("Sessions show up when CC is running on a peer machine.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var connectionBadge: some View {
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
            .frame(width: 10, height: 10)
            .accessibilityLabel(observer.aggregateState.accessibilityLabel)
    }
}

struct SessionRowView: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.project ?? "—")
                    .font(.headline)
                Spacer()
                Text(session.status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let branch = session.branch {
                Text(branch)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(session.originAgent)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}
