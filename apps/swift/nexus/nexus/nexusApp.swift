//
//  nexusApp.swift
//  nexus
//
//  Menu bar client for the Nexus agent (peer-to-peer Claude Code session monitor).
//  Replaces the Xcode SwiftUI+SwiftData template with a `MenuBarExtra(.window)`
//  scene + separate `Settings` scene per design.md §A1/A6/A7.
//

import SwiftUI
import NexusShared

@main
struct nexusApp: App {
    @StateObject private var viewModel = NexusViewModel.shared

    // INTERIM (nx-4ohfs): seed the dashboard endpoint override to the
    // homelab agent on first launch if unset. The local Mac agent is
    // frequently down (launchctl I/O wedge); homelab over Tailscale holds
    // the live CC sessions. Reproducible + survives `defaults delete`.
    // TODO(nx-4ohfs): drop this seed once the agents.toml multi-agent
    // aggregation + Settings-UI editor land — endpoint becomes
    // user-configured, not hardcoded.
    /// XCUITest seam (spec add-fullstack-integration-test-gate 2.2–2.4,
    /// bd:nx-68ulr). When launched with `-uitest-open-dashboard`, the
    /// singleton dashboard `Window` is presented at launch. The app is
    /// `LSUIElement` (no Dock window, the popover is lazy), so XCUITest
    /// cannot reach the dashboard via the menu-bar click / global ⌘D.
    /// A singleton `Window` (not `WindowGroup`) is Apple's documented
    /// deterministic path for `.defaultLaunchBehavior(.presented)`;
    /// `WindowGroup`'s present-at-launch is scene-restoration dependent
    /// and flaked across the harness's repeated launches. Inert in normal
    /// launches (the argument is never present).
    private let uiTestOpensDashboard =
        CommandLine.arguments.contains("-uitest-open-dashboard")

    init() {
        if SettingsStore.shared.dashboardEndpoint == nil {
            SettingsStore.shared.dashboardEndpoint = "http://100.73.182.4:7400"
        }
    }

    var body: some Scene {
        MenuBarExtra {
            NexusPanel()
                .environmentObject(viewModel)
        } label: {
            StatusIcon(state: viewModel.aggregateState, ttsMuted: !viewModel.ttsEnabled)
        }
        .menuBarExtraStyle(.window)

        // Full-window dashboard parity scene — bd:nx-gaquu. Opened via
        // ⌘D / Window menu; mirrors the web `/sessions`, `/specs`,
        // `/projects`, `/credentials`, `/failures`, `/notifications`,
        // `/settings`, `/health`, `/integrations`, and PTY routes.
        //
        // BREAKING CHANGE (bd:nx-68ulr, user-authorized): this was a
        // `WindowGroup(id:"dashboard")` (could spawn multiple dashboard
        // windows). It is now a SINGLETON `Window` — one dashboard window,
        // re-summoned/focused on subsequent ⌘D. Single-window dashboard
        // semantics are an accepted product change; the win is a
        // deterministic `.defaultLaunchBehavior(.presented)` so the
        // integration-gate XCUITests can open it reliably.
        dashboardScene
            .windowResizability(.contentMinSize)

        Settings {
            PreferencesScene()
                .environmentObject(viewModel)
        }
    }

    private var dashboardScene: some Scene {
        Window("Nexus Dashboard", id: "dashboard") {
            AppNavigation()
                .environmentObject(viewModel)
        }
        .uiTestLaunchBehavior(presentAtLaunch: uiTestOpensDashboard)
    }
}

private extension Scene {
    /// Applies `.defaultLaunchBehavior(.presented)` when `presentAtLaunch`
    /// is true and the OS supports it (macOS 15+); otherwise returns the
    /// scene unchanged. Applied to the SINGLETON dashboard `Window` so the
    /// XCUITest seam (spec 2.2–2.4, bd:nx-68ulr) presents it
    /// deterministically at launch — `Window` (not `WindowGroup`) makes
    /// `.presented` restoration-independent. Declared as a separate
    /// availability-gated SceneBuilder method to avoid the SceneBuilder
    /// `else`-restriction (Apple docs) and the opaque-type compiler crash
    /// the inline `if #available`/`if #unavailable` pair triggered.
    @SceneBuilder
    func uiTestLaunchBehavior(presentAtLaunch: Bool) -> some Scene {
        if #available(macOS 15, *) {
            self.defaultLaunchBehavior(presentAtLaunch ? .presented : .automatic)
        }
        // No `else`/`#unavailable` branch — SceneBuilder forbids `else`
        // and a paired `#unavailable` re-triggers the opaque-type crash.
        // On macOS < 15 (never the Tier-B GUI build machine) the modifier
        // is simply not applied; the Window the caller declared still
        // opens on demand via the popover ⌘D.
    }
}
