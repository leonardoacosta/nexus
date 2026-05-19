// SessionsView — macOS dashboard parity for apps/nextjs/src/app/session.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.2)
//
// NexusShared-based replacement for the legacy SessionList. Binds to a
// `SessionObserver` (cross-platform observer that consumes /sessions +
// the agent SSE stream) so the same code can be reused on iOS. The
// legacy `SessionList.swift` continues to back the menu-bar popover via
// `NexusViewModel` until the nexus-mac NexusShared migration (nx-4roof)
// retires it.

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

    public init() {
        _observer = StateObject(wrappedValue: SessionObserver())
        ownsLifecycle = true
    }

    public init(observer: SessionObserver) {
        _observer = StateObject(wrappedValue: observer)
        ownsLifecycle = false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if observer.activeSessions.isEmpty {
                emptyState
            } else {
                listBody
            }
        }
        .padding(.vertical, 8)
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
                ForEach(observer.activeSessions) { session in
                    SessionsRowView(session: session)
                    Divider().padding(.leading, 14)
                }
            }
        }
    }
}

private struct SessionsRowView: View {
    let session: Session

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.project ?? "—")
                    .font(.system(.body, design: .monospaced))
                HStack(spacing: 6) {
                    if let branch = session.branch {
                        Text(branch)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let model = session.model {
                        Text(model)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(session.status)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                Text(session.originAgent)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }
}
