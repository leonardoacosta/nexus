// AttachScene — full-screen SwiftTerm + LIVE PTY attach over the Tailnet.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
// bd:mx-rkir.3 — a notification tap opens the LIVE tmux PTY (not a stub).
// bd:mx-rkir.8 — ACTIVE sessions never render the terminal (idle ones do).
//   ROOT CAUSE: the session was resolved REACTIVELY every render via a
//   computed `observer.sessions.first(where:)`. `observer.sessions` is
//   @Published and republishes on EVERY SSE heartbeat. ACTIVE sessions
//   heartbeat constantly → the array replaces → the computed `session`
//   recomputes → with `.id(session.id)` SwiftUI tore down + reconnected the
//   PTY (or momentarily resolved nil → flipped to "Connecting…"/"not
//   attachable") on every beat → the terminal never stayed up. IDLE/ENDED
//   sessions don't update → stable → rendered fine.
//   FIX: snapshot the resolution ONCE into @State on first appearance, freeze
//   it, and render the terminal branch from the stable snapshot so heartbeat
//   republishes neither recompute it nor change `.id`. The terminal mounts
//   exactly once per AttachScene presentation.
//
// Wires the SwiftTerm `TerminalView` into a SwiftUI host. The transport is
// the agent's WebSocket PTY (NexusShared.NexusAggregateClient) — the SAME
// path macOS PtyViewer uses. There is no SSH stack; macOS never used one.

import SwiftUI
import NexusShared
import os
#if canImport(UIKit)
import UIKit
#endif

private let attachLog = Logger(subsystem: "dev.priceless.nexus", category: "AttachSceneIOS")

/// Diagnostic PTY logger (mx-rkir.6/.8) — `.notice` so it streams via
/// `devicectl device console`; grep tag `NXPTY`.
private let nxptyLog = Logger(subsystem: "dev.priceless.nexus", category: "pty")

struct AttachScene: View {
    let sessionId: String

    @EnvironmentObject private var observer: SessionObserver
    @Environment(\.dismiss) private var dismiss

    @State private var status: AttachStatus = .idle

    /// One-time snapshot of the resolved session. Set ONCE — on first
    /// appearance (warm-launch) or the first heartbeat that carries the row in
    /// (cold-launch) — then FROZEN. Subsequent @Published republishes of
    /// `observer.sessions` (constant on ACTIVE sessions) never overwrite it, so
    /// the terminal branch + its `.id` stay stable and the PTY mounts once.
    @State private var resolved: Session?

    var body: some View {
        NavigationStack {
            Group {
                if let resolved, let tmuxTarget = resolved.tmuxTarget {
                    // Session resolved AND attachable — render the live PTY from
                    // the FROZEN snapshot. `.id` is keyed on the snapshot id (set
                    // once) so heartbeat republishes do NOT rebuild the host.
                    TerminalHostView(
                        session: resolved,
                        tmuxTarget: tmuxTarget,
                        client: observer.client,
                        status: $status
                    )
                    .ignoresSafeArea(edges: .bottom)
                    .id(resolved.id)
                } else if resolved == nil {
                    // Cold-launch / mid-load: the row hasn't arrived yet. Show
                    // loading; the resolve-once path (.task / .onChange) flips us
                    // into the terminal branch when the row FIRST lands.
                    ContentUnavailableView {
                        Label("Connecting…", systemImage: "terminal")
                    } description: {
                        Text("Resolving session over the Tailnet.")
                    } actions: {
                        ProgressView()
                    }
                } else {
                    // Snapshot resolved but the session genuinely has no tmux
                    // target — graceful unavailable (the only legit
                    // non-attachable case).
                    ContentUnavailableView(
                        "Session not attachable",
                        systemImage: "exclamationmark.triangle",
                        description: Text("This session has no tmux target.")
                    )
                }
            }
            .navigationTitle(resolved?.project ?? "Attach")
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
        // so the session row lands. Resolve ONCE here (warm path) and via
        // .onChange below (cold path), then freeze.
        .task {
            resolveOnce()
            observer.startStreams()
            await observer.refreshSessions()
            resolveOnce()
        }
        // Cold-launch: the row arrives on a later heartbeat. Resolve the FIRST
        // time it appears, then freeze — later republishes are short-circuited
        // by the `resolved != nil` guard in resolveOnce().
        .onChange(of: observer.sessions) {
            resolveOnce()
        }
    }

    /// Resolve the session snapshot exactly once. After `resolved` is set it is
    /// never overwritten — this is the freeze that makes the terminal branch
    /// immune to ACTIVE-session heartbeat republishes.
    private func resolveOnce() {
        guard resolved == nil else { return }
        guard let match = observer.sessions.first(where: { $0.id == sessionId }) else {
            attachLog.debug("nx-rkir8 resolveOnce: row not present yet for id=\(sessionId, privacy: .public) (keep Connecting…)")
            nxptyLog.notice("NXPTY attach.render branch=connecting sid=\(sessionId, privacy: .public) resolved=false tmux=nil sessionType=nil")
            return
        }
        resolved = match
        let branch = match.tmuxTarget == nil ? "notAttachable" : "terminal"
        attachLog.debug("nx-rkir8 resolveOnce FROZEN branch=\(branch, privacy: .public) id=\(match.id, privacy: .public) tmux=\(match.tmuxTarget ?? "nil", privacy: .public) status=\(match.status, privacy: .public)")
        nxptyLog.notice("NXPTY attach.render branch=\(branch, privacy: .public) sid=\(match.id, privacy: .public) resolved=true tmux=\(match.tmuxTarget ?? "nil", privacy: .public) sessionType=\(match.sessionType ?? "nil", privacy: .public)")
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status {
        case .idle:
            if resolved == nil { ProgressView() } else { Text("idle").font(.caption2) }
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
