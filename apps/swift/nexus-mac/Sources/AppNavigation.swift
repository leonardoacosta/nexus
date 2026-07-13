// AppNavigation — full-window dashboard scene for nexus-mac.
//
// Spec: openspec/changes/refocus-board-shell (task 3.2)
//
// Refocused from a 12-section NavigationSplitView into a single
// project-structure board (design § 01/02). The sidebar of peer destinations
// is gone: `DashboardSection` collapses to `.board` + `.settings`, the board
// IS the window, and the titlebar reduces to one homelab presence dot (with a
// process-table popover reusing `ProcessTableView`) plus a bell that summons
// the notification drawer. Settings is a separate ⌘, scene (SettingsLink).
//
// Operational surfaces (roadmap, specs, projects, failures, health,
// notifications-as-a-tab, PTY-as-a-tab, decide deck) are absorbed per the
// design disposition table and deleted in task 3.5.

import AppKit
import SwiftUI
import NexusShared

/// Collapsed navigation surface. Retained (rather than deleted outright) so
/// the persisted `nx.dashboard.defaultView` key and any legacy deep-link can
/// still resolve to a valid case; every legacy value migrates to `.board`.
enum DashboardSection: String, CaseIterable, Identifiable, Hashable {
    case board
    case settings

    var id: String { rawValue }

    var label: String {
        switch self {
        case .board:    return "Board"
        case .settings: return "Settings"
        }
    }

    /// Migrate a persisted `nx.dashboard.defaultView` value. Every legacy
    /// section (`sessions`, `specs`, `roadmap`, …) folds into the board.
    static func migrated(fromDefault raw: String?) -> DashboardSection {
        DashboardSection(rawValue: raw ?? "") ?? .board
    }
}

struct AppNavigation: View {
    @ObservedObject private var observer: SessionObserver
    @StateObject private var coordinator = DashboardNavigationCoordinator()

    @State private var showDrawer = false
    @State private var seenNotificationCount = 0
    @State private var showProcessPopover = false

    init(observer: SessionObserver) {
        self.observer = observer
        // Task 3.2: one-time migration of a stale persisted default view. Any
        // value that is not `board`/`settings` (the only surviving sections)
        // is rewritten to `board` so a returning user lands on the board.
        let key = "nx.dashboard.defaultView"
        let stored = UserDefaults.standard.string(forKey: key)
        if DashboardSection(rawValue: stored ?? "") == nil {
            UserDefaults.standard.set(DashboardSection.board.rawValue, forKey: key)
        }
    }

    private var unreadCount: Int {
        max(0, observer.notifications.count - seenNotificationCount)
    }

    var body: some View {
        VStack(spacing: 0) {
            titlebar
            ticker
            Divider().overlay(Color.nx.hairline)
            BoardView(observer: observer)
        }
        .background(Color.nx.substrate)
        .environmentObject(coordinator)
        .overlay(alignment: .trailing) {
            if showDrawer {
                NotificationDrawer(onClose: { withAnimation { showDrawer = false } })
                    .frame(width: 420)
                    .transition(.move(edge: .trailing))
                    .zIndex(10)
            }
        }
        .background(WindowAccessor { window in
            window.collectionBehavior.insert(.fullScreenPrimary)
            NSApp.activate(ignoringOtherApps: true)
        })
        .task {
            observer.startStreams()
            await observer.refreshSessions()
        }
        // Legacy deep-links now route to the board (the only work surface);
        // draining a pending link just clears it.
        .onChange(of: coordinator.pendingDeepLink) { _, newValue in
            if newValue != nil { coordinator.clear() }
        }
    }

    // MARK: - Titlebar

    private var titlebar: some View {
        HStack(spacing: 16) {
            Text("NE")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .tracking(2.4)
                .foregroundStyle(Color.nx.ink)
            + Text("X")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(Color.nx.phosphor)
            + Text("US")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .tracking(2.4)
                .foregroundStyle(Color.nx.ink)

            Spacer()

            presenceDot
            SettingsLink {
                Image(systemName: "gearshape")
                    .foregroundStyle(Color.nx.ink2)
            }
            .buttonStyle(.plain)
            .help("Settings (⌘,)")
            bell
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color.nx.substrate2)
    }

    private var presenceDot: some View {
        Button {
            showProcessPopover.toggle()
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(observer.peerReachable ? Color.nx.phosphor : Color.nx.ink4)
                    .frame(width: 6, height: 6)
                Text("homelab")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(Color.nx.ink2)
            }
        }
        .buttonStyle(.plain)
        .help("Homelab agent presence — click for process table")
        .accessibilityIdentifier("titlebar-presence-dot")
        .popover(isPresented: $showProcessPopover) {
            ProcessTablePopover()
                .frame(width: 420, height: 320)
        }
    }

    private var bell: some View {
        Button {
            withAnimation { showDrawer.toggle() }
            if showDrawer { seenNotificationCount = observer.notifications.count }
        } label: {
            Image(systemName: "bell")
                .foregroundStyle(Color.nx.ink2)
                .overlay(alignment: .topTrailing) {
                    if unreadCount > 0 {
                        Text("\(min(unreadCount, 99))")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Color.nx.critical)
                            .clipShape(Capsule())
                            .offset(x: 8, y: -7)
                    }
                }
        }
        .buttonStyle(.plain)
        .help("Notifications (⌘H)")
        .keyboardShortcut("h", modifiers: .command)
        .accessibilityIdentifier("titlebar-bell")
    }

    // MARK: - TTS ticker (ambient, one line)

    private var ticker: some View {
        HStack(spacing: 12) {
            HStack(spacing: 7) {
                Circle().fill(Color.nx.phosphor).frame(width: 5, height: 5)
                Text("TTS")
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Color.nx.phosphor)
            }
            if let latest = observer.notifications.first {
                Text(latest.title?.isEmpty == false ? latest.title! : latest.body)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Color.nx.ink2)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Text(latest.receivedAt, style: .relative)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.nx.ink4)
            } else {
                Text("Ambient notification ticker — waiting for the next event.")
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Color.nx.ink4)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(
            LinearGradient(
                colors: [Color.nx.phosphor.opacity(0.06), .clear],
                startPoint: .leading, endPoint: .trailing)
        )
    }
}

/// Titlebar process-table popover — reuses `ProcessTableView` (design § 03:
/// Health collapses into presence dot + process table on demand). Fetches the
/// homelab agent's top-CPU/RAM snapshot lazily on open.
struct ProcessTablePopover: View {
    @State private var processes = HealthProcessesResponse(topCpu: [], topRam: [], collectedAt: nil)
    private let client = NexusShared.NexusAggregateClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PROCESSES · homelab")
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Color.nx.ink4)
                .padding(.horizontal, 14).padding(.top, 12)
            ProcessTableView(processes: processes)
            Spacer(minLength: 0)
        }
        .task { processes = await client.fetchHealthProcesses(limit: 8) }
    }
}
