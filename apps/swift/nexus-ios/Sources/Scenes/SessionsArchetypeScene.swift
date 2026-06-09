// SessionsArchetypeScene (mx-rkir.4) — the iOS Sessions tab, re-sourced from
// the rich NexusShared.Session model via SessionObserver (the same /sessions
// data the macOS SessionsView + the legacy SessionListScene consume), NOT the
// thin TriageItem/SessionBody.
//
// Row layout (drops the meaningless local/claude badges):
//   Row 1: [Project Name]              — stripped of org prefix, bold.
//   Row 2: {status dot} [cwd] > [branch] [git status]
// Tap -> sets navigation.attachingSessionId -> RootScene's existing
// `.sheet(item:){ AttachScene(sessionId:) }` opens the LIVE PTY (mx-rkir.3),
// NOT the metadata DetailScene. Mirrors the macOS stale-tap guard.
//
// Status taxonomy: see SessionDisplayStatus below. We derive the BEST mapping
// from the fields Session actually carries (status / agentState / sessionType /
// endedAt / idleSince). States with NO backing field are documented there.

import SwiftUI
import NexusShared

struct SessionsArchetypeScene: View {
    @EnvironmentObject private var observer: SessionObserver
    @EnvironmentObject private var navigation: NavigationState

    /// Transient "session ended" toast — mirrors the macOS stale-tap guard
    /// (SessionsView.handleSessionTap): a row tapped after the session
    /// vanished from the latest /sessions fetch shows a toast instead of
    /// opening AttachScene into a permanent "connecting" hang.
    @State private var staleToast: String?

    var body: some View {
        List {
            if !active.isEmpty {
                Section("Active") { ForEach(active) { row($0) } }
            }
            if !idleEnded.isEmpty {
                Section("Idle / Ended") { ForEach(idleEnded) { row($0) } }
            }
            if rows.isEmpty {
                Section {
                    ContentUnavailableView("No sessions", systemImage: "terminal")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Sessions")
        .overlay(alignment: .top) {
            if let staleToast { staleToastView(staleToast) }
        }
        .refreshable { await observer.refreshSessions() }
        .accessibilityIdentifier("sessions-archetype-scene")
        .task {
            observer.startStreams()
            await observer.refreshSessions()
        }
    }

    // MARK: - Sections

    /// Real CC sessions only (drop telemetry-ping stubs). We render from the
    /// full `sessions` set — NOT `activeSessions` — so ended / idle rows still
    /// surface in the "Idle / Ended" section.
    private var rows: [Session] {
        observer.sessions
            .filter { $0.hasCCFingerprint }
            .sorted { a, b in
                let la = repoTail(for: a)
                let lb = repoTail(for: b)
                if la != lb { return la < lb }
                return a.id < b.id
            }
    }

    private var active: [Session] {
        rows.filter { !SessionDisplayStatus.derive(from: $0).isEnded }
    }

    private var idleEnded: [Session] {
        rows.filter { SessionDisplayStatus.derive(from: $0).isEnded }
    }

    // MARK: - Row

    private func row(_ session: Session) -> some View {
        Button {
            handleTap(session)
        } label: {
            SessionRow(session: session, projectName: repoTail(for: session))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session-row-\(session.id)")
    }

    /// Stale-tap guard cloned from macOS SessionsView.handleSessionTap: only
    /// open Attach if the tapped row is still in the most recent fetch.
    private func handleTap(_ session: Session) {
        let stillLive = observer.sessions.contains { $0.id == session.id }
        guard stillLive else {
            staleToast = "session ended — \(repoTail(for: session))"
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                staleToast = nil
            }
            return
        }
        navigation.attachingSessionId = session.id
    }

    private func staleToastView(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message).font(.caption.monospaced()).lineLimit(1)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
        .padding(.top, 6)
        .accessibilityIdentifier("sessions-stale-toast")
    }

    /// Project NAME for Row 1. `Session.projectLabel(for:)` does NOT strip the
    /// org prefix (it returns the full decoded `gitOwnerRepo`, e.g.
    /// "brownandbrowninc/Wholesale Architecture"), so we take the repo tail —
    /// the last path segment — to render "Wholesale Architecture". Falls back
    /// through projectLabel's own ladder for non-git rows.
    private func repoTail(for session: Session) -> String {
        let label = Session.projectLabel(for: session)
        if let slash = label.lastIndex(of: "/") {
            let tail = String(label[label.index(after: slash)...])
            if !tail.isEmpty { return tail }
        }
        return label
    }
}

// MARK: - Display status taxonomy

/// The 6-state status taxonomy requested for the iOS Sessions tab, derived
/// from the fields `Session` actually carries. HONEST data-availability notes
/// live inline per case — backend follow-up issues should add the missing
/// signals (see the file-level report for the consolidated list).
enum SessionDisplayStatus {
    /// Agent actively working a turn (blocking). Backed by `agentState == .blocked`.
    case activelyRunning
    /// Agent blocked awaiting input — needs me (blocking). Backed by
    /// `agentState == .waiting`.
    case waitingForMe
    /// Parallel sub-agents fanned out (non-blocking). NO BACKING FIELD —
    /// Session carries no sub-agent / parallel-fan-out signal, so this state
    /// is never produced. Renders as the closest real state instead.
    case parallelAgents
    /// Background monitor session (non-blocking). NO BACKING FIELD — Session
    /// has no monitor classification, so this state is never produced.
    case monitor
    /// Session live but idle (alive, not ended) — agentState .ready, or active
    /// status with no blocking agentState.
    case waitingReady
    /// Session ended / stale. Backed by `endedAt != nil` or status ended/stale.
    case stale

    var isEnded: Bool { self == .stale }

    /// Best-effort mapping from the fields Session exposes. Precedence:
    /// ended-ness wins, then the agent-activity axis (agentState), then the
    /// lifecycle/liveness axis (status).
    static func derive(from session: Session) -> SessionDisplayStatus {
        let status = session.status.lowercased()
        if session.endedAt != nil || status == "ended" || status == "stale" {
            return .stale
        }
        switch session.agentState {
        case .blocked: return .activelyRunning
        case .waiting: return .waitingForMe
        case .ready:   return .waitingReady
        case .none:
            // No agent-activity signal — fall back to the liveness axis.
            return status == "active" ? .waitingReady : .stale
        }
    }

    /// Distinct color per state. parallelAgents / monitor have no producer but
    /// are colored for completeness should a backend signal arrive later.
    var color: Color {
        switch self {
        case .activelyRunning: return .green
        case .waitingForMe:    return .blue
        case .parallelAgents:  return .purple
        case .monitor:         return .teal
        case .waitingReady:    return .yellow
        case .stale:           return .secondary
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .activelyRunning: return "actively running"
        case .waitingForMe:    return "waiting for me"
        case .parallelAgents:  return "parallel agents"
        case .monitor:         return "monitor"
        case .waitingReady:    return "waiting ready"
        case .stale:           return "stale"
        }
    }
}

extension SessionDisplayStatus: Equatable {}

// MARK: - Row view

private struct SessionRow: View {
    let session: Session
    let projectName: String

    private var display: SessionDisplayStatus {
        SessionDisplayStatus.derive(from: session)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Row 1: project name (stripped), bold.
            Text(projectName)
                .font(.headline)
                .lineLimit(1)

            // Row 2 (mx-rkir.7 FIX 3): session-name subtitle, between the bold
            // project (Row 1) and the status/cwd/branch line (Row 3). Uses the
            // tmux session name (`Session.tmuxSession`) when present; omitted
            // entirely when absent. Styled as a secondary subtitle (smaller,
            // secondary color) so it reads distinctly from the project title.
            if let name = sessionName {
                Text(name)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            // Row 3: {status dot} [cwd] > [branch] [git status]
            HStack(spacing: 6) {
                Circle()
                    .fill(display.color)
                    .frame(width: 9, height: 9)
                    .accessibilityLabel(display.accessibilityLabel)
                if let cwd = abbreviatedCwd {
                    Text(cwd)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                if let branch = session.branch, !branch.isEmpty {
                    Text(">")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Text(branch)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Human session name for the subtitle (mx-rkir.7 FIX 3). `tmuxSession` is
    /// the tmux session name carried on the Session model; omit the subtitle
    /// when it is absent or empty.
    private var sessionName: String? {
        guard let name = session.tmuxSession, !name.isEmpty else { return nil }
        return name
    }

    /// Abbreviate a REMOTE session cwd by PATH PATTERN, not by the iOS device
    /// sandbox home. mx-rkir.7 FIX 2: `abbreviatingWithTildeInPath` uses the
    /// device's own NSHomeDirectory, which never matches a remote cwd like
    /// `/Users/leonardoacosta/dev/mx` or `/home/nyaptor/dev/nx`, so it left the
    /// full absolute path. Instead, collapse a leading `/Users/<user>/` or
    /// `/home/<user>/` to `~/` (and exact `/Users/<user>` or `/home/<user>` to
    /// `~`). Non-home absolute paths pass through unchanged.
    private var abbreviatedCwd: String? {
        guard let cwd = session.cwd, !cwd.isEmpty else { return nil }
        return SessionRow.abbreviateHomePath(cwd)
    }

    /// `^/(Users|home)/<user>/` -> `~/`; exact `/(Users|home)/<user>` -> `~`.
    static func abbreviateHomePath(_ path: String) -> String {
        if let prefixRange = path.range(
            of: #"^/(?:Users|home)/[^/]+/"#,
            options: .regularExpression
        ) {
            return "~/" + path[prefixRange.upperBound...]
        }
        if path.range(
            of: #"^/(?:Users|home)/[^/]+$"#,
            options: .regularExpression
        ) != nil {
            return "~"
        }
        return path
    }
}

#if DEBUG
#Preview("Sessions (sample)") {
    let observer = SessionObserver()
    return NavigationStack {
        SessionsArchetypeScene()
            .environmentObject(observer)
            .environmentObject(NavigationState())
    }
}
#endif
