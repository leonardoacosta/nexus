// AppNavigation — full-window dashboard scene for nexus-mac.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.1)
// bd:nx-gaquu
//
// The menu-bar popover (`NexusPanel`) remains the at-a-glance surface.
// This NavigationSplitView is the expanded dashboard parity replacement
// for the web `apps/nextjs/src/app/*` routes. All 10 parity views live
// behind a single sidebar so the user can park the window on a second
// monitor and watch everything at once.
//
// Wired into `nexusApp.swift` as a `WindowGroup("Nexus Dashboard")` scene
// alongside the existing `MenuBarExtra` + `Settings` scenes.

import AppKit
import SwiftUI
import NexusShared

enum DashboardSection: String, CaseIterable, Identifiable, Hashable {
    case sessions
    case specs
    case projects
    case credentials
    case failures
    case notifications
    case health
    case integrations
    case settings
    case pty

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sessions:      return "Sessions"
        case .specs:         return "Specs"
        case .projects:      return "Projects"
        case .credentials:   return "Credentials"
        case .failures:      return "Failures"
        case .notifications: return "Notifications"
        case .health:        return "Health"
        case .integrations:  return "Integrations"
        case .settings:      return "Settings"
        case .pty:           return "PTY Viewer"
        }
    }

    var systemImage: String {
        switch self {
        case .sessions:      return "terminal"
        case .specs:         return "doc.text"
        case .projects:      return "folder"
        case .credentials:   return "key"
        case .failures:      return "exclamationmark.triangle"
        case .notifications: return "bell"
        case .health:        return "waveform.path.ecg"
        case .integrations:  return "link"
        case .settings:      return "gearshape"
        case .pty:           return "rectangle.on.rectangle"
        }
    }
}

struct AppNavigation: View {
    @State private var selection: DashboardSection = defaultSection()
    @State private var ptySessionId: String = ""

    // Multi-agent observer — OWNED by `nexusApp` as an `@StateObject`
    // and injected here via `init(observer:)` so the SSE + polling
    // pumps begin at @main scope (bd:nx-q7lmb). Pre-fix this was an
    // inline `@StateObject private var observer = SessionObserver()`,
    // which gated stream startup on the dashboard `Window`'s view tree
    // mounting — SwiftUI Window scenes lazy-mount, so cold launches
    // showed ZERO TCP sockets to homelab until the user clicked the
    // menu bar item. The `.task { observer.startStreams() }` modifier
    // below stays as a defensive idempotent retry (the underlying
    // `if sseTask == nil` guard short-circuits when streams are
    // already running). See the `bd:nx-t9wrj` note carried forward:
    // SessionsView is lazy-instantiated by NavigationSplitView, so the
    // observer MUST live above it — that constraint is preserved by
    // App-scope ownership.
    @ObservedObject private var observer: SessionObserver

    // Cross-tab deep-link router. ProjectAccordionRow (Projects tab) calls
    // `coordinator.openSession(_:)`, which flips a published
    // `pendingDeepLink`. We watch the published value here and switch the
    // active tab to `.sessions`; `SessionsView` then drains the link in
    // its own `.task`. Spec: projects-tab-accordion-deeplink task 2.2.
    @StateObject private var coordinator = DashboardNavigationCoordinator()

    /// Injected by `nexusApp` so SSE/polling begin at @main scope
    /// (bd:nx-q7lmb). Callers in tests that need a fresh observer can
    /// pass `SessionObserver()` directly.
    init(observer: SessionObserver) {
        self.observer = observer
    }

    var body: some View {
        NavigationSplitView {
            List(DashboardSection.allCases, selection: $selection) { section in
                NavigationLink(value: section) {
                    Label(section.label, systemImage: section.systemImage)
                }
                // Stable hook for the render-all-pages XCUITest guard
                // (spec 2.2, bd:nx-u17ua) — fault #4 (SessionsView never
                // mounts) regression surface.
                .accessibilityIdentifier("sidebar-\(section.rawValue)")
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
        } detail: {
            detailView
                .frame(minWidth: 480, minHeight: 360)
                // Identifies which detail destination actually mounted so
                // the guard test asserts the pane rendered (not just that
                // the sidebar row exists). `.contain` exposes this as a
                // single queryable container even when the section view
                // nests its own ScrollView/Stack.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("detail-\(selection.rawValue)")
        }
        .navigationTitle("Nexus")
        .environmentObject(coordinator)
        // Bridge to the underlying NSWindow so we can (a) opt the
        // dashboard `Window` into native green-button fullscreen via
        // `.fullScreenPrimary`, and (b) claim foreground focus on
        // launch — SwiftUI `Window` does not auto-activate the app
        // even with LSUIElement=false. Spec: bd:nx-chztj (nx-2pmzs
        // follow-up).
        .background(WindowAccessor { window in
            window.collectionBehavior.insert(.fullScreenPrimary)
            NSApp.activate(ignoringOtherApps: true)
        })
        .task {
            observer.startStreams()
            await observer.refreshSessions()
        }
        // Tab-switch hook: when a producer flips `pendingDeepLink`, jump
        // to Sessions so SessionsView's drain task fires. Leaving the
        // pending link in place hands the drain off to SessionsView; it
        // calls `coordinator.clear()` once the PTY mount commits.
        .onChange(of: coordinator.pendingDeepLink) { _, newValue in
            guard newValue != nil else { return }
            if selection != .sessions {
                selection = .sessions
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection {
        case .sessions:      SessionsView(observer: observer)
        case .specs:         SpecsView(sessionObserver: observer)
        case .projects:      ProjectsView(sessionObserver: observer)
        case .credentials:   CredentialsView()
        case .failures:      FailuresView()
        case .notifications: NotificationsView()
        case .health:        HealthView()
        case .integrations:  IntegrationsView()
        case .settings:      SettingsView()
        case .pty:           ptyDetail
        }
    }

    private var ptyDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("PTY VIEWER")
                    .font(.system(.caption, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(.secondary)
                TextField("session id", text: $ptySessionId)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 360)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            if ptySessionId.isEmpty {
                ContentUnavailableView(
                    "Enter a session id",
                    systemImage: "rectangle.on.rectangle",
                    description: Text("Paste a Claude Code session id to subscribe to its PTY stream.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                PtyViewer(sessionId: ptySessionId, sessionLabel: nil)
            }
        }
    }

    private static func defaultSection() -> DashboardSection {
        let raw = UserDefaults.standard.string(forKey: "nx.dashboard.defaultView") ?? "sessions"
        return DashboardSection(rawValue: raw) ?? .sessions
    }
}
