// AttachScene — full-screen SwiftTerm + LIVE PTY attach over the Tailnet.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
// bd:mx-rkir.3 — a notification tap opens the LIVE tmux PTY (not a stub).
//
// Wires the SwiftTerm `TerminalView` into a SwiftUI host. The transport is
// the agent's WebSocket PTY (NexusShared.NexusAggregateClient) — the SAME
// path macOS PtyViewer uses. There is no SSH stack; macOS never used one.

import SwiftUI
import NexusShared
#if canImport(UIKit)
import UIKit
#endif

struct AttachScene: View {
    let sessionId: String

    @EnvironmentObject private var observer: SessionObserver
    @Environment(\.dismiss) private var dismiss

    @State private var status: AttachStatus = .idle

    private var session: Session? {
        observer.sessions.first(where: { $0.id == sessionId })
    }

    /// The session list hasn't produced THIS session yet. On a cold-launch
    /// (notification tap before sessions load) we must show a loading state and
    /// attach once the row arrives — NOT the static "not attachable" error.
    private var isResolving: Bool {
        session == nil && observer.sessions.isEmpty
    }

    var body: some View {
        NavigationStack {
            Group {
                if let session, let tmuxTarget = session.tmuxTarget {
                    // Session resolved AND attachable — render the live PTY.
                    TerminalHostView(
                        session: session,
                        tmuxTarget: tmuxTarget,
                        client: observer.client,
                        status: $status
                    )
                    .ignoresSafeArea(edges: .bottom)
                    .id(session.id) // re-attach if the session row identity changes
                } else if isResolving || (session == nil) {
                    // Cold-launch / mid-load: sessions not in yet. Show loading
                    // and let `.task`/observer refresh resolve the row; the view
                    // re-renders into the terminal branch when it arrives.
                    ContentUnavailableView {
                        Label("Connecting…", systemImage: "terminal")
                    } description: {
                        Text("Resolving session over the Tailnet.")
                    } actions: {
                        ProgressView()
                    }
                } else {
                    // Session loaded but genuinely has no tmux target — graceful
                    // unavailable (the only legit non-attachable case).
                    ContentUnavailableView(
                        "Session not attachable",
                        systemImage: "exclamationmark.triangle",
                        description: Text("This session has no tmux target.")
                    )
                }
            }
            .navigationTitle(session?.project ?? "Attach")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    statusBadge
                }
            }
        }
        // Cold-launch race: the tap may open this sheet before the polling loop
        // has fetched sessions. Ensure streams are running and force a refresh
        // so the session row lands and the terminal branch renders.
        .task {
            observer.startStreams()
            await observer.refreshSessions()
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status {
        case .idle:
            if isResolving { ProgressView() } else { Text("idle").font(.caption2) }
        case .connecting:  ProgressView()
        case .connected:   Image(systemName: "circle.fill").foregroundStyle(.green)
        case .failed(let msg):
            Image(systemName: "xmark.octagon.fill")
                .foregroundStyle(.red)
                .accessibilityLabel(msg)
        }
    }
}

enum AttachStatus: Equatable {
    case idle
    case connecting
    case connected
    case failed(String)
}
