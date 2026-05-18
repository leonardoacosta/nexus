// ContentView — primary watchOS surface.
//
// Spec: openspec/changes/scaffold-nexus-watch-target (task 1.3)
//
// Compact summary: live session count + most-recent alert. Designed for
// glanceability — no scrolling on Series 7+ unless the last alert is long.

import SwiftUI
import NexusShared

struct ContentView: View {
    @EnvironmentObject private var observer: SessionObserver

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            sessionsRow
            Divider()
            alertSection
            Spacer(minLength: 0)
            stateBadge
        }
        .padding()
    }

    private var sessionsRow: some View {
        HStack {
            Image(systemName: "terminal")
                .foregroundStyle(.tint)
            Text("\(observer.activeSessions.count)")
                .font(.title.monospacedDigit())
            Text(observer.activeSessions.count == 1 ? "session" : "sessions")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var alertSection: some View {
        if let last = observer.notifications.first {
            VStack(alignment: .leading, spacing: 2) {
                if let title = last.title, !title.isEmpty {
                    Text(title).font(.caption.weight(.semibold))
                }
                Text(last.body)
                    .font(.caption2)
                    .lineLimit(3)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("No recent alerts")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
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
        return HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(observer.aggregateState.rawValue)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
        }
    }
}
