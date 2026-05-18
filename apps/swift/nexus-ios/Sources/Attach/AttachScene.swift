// AttachScene — full-screen SwiftTerm + SSH attach over Tailnet.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
//
// Wires the SwiftTerm `TerminalView` into a SwiftUI host. The SSH
// transport is implemented in SshTerminalSession (kept separate so the
// real wire-up — SwiftNIO-SSH or libssh2 — can swap in without touching
// the view layer).

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

    var body: some View {
        NavigationStack {
            Group {
                if let session, let tmuxTarget = session.tmuxTarget {
                    TerminalHostView(
                        session: session,
                        tmuxTarget: tmuxTarget,
                        status: $status
                    )
                    .ignoresSafeArea(edges: .bottom)
                } else {
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
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status {
        case .idle:        Text("idle").font(.caption2)
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
