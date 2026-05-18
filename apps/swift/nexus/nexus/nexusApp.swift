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
        // ⌘N / Window menu; mirrors the web `/sessions`, `/specs`,
        // `/projects`, `/credentials`, `/failures`, `/notifications`,
        // `/settings`, `/health`, `/integrations`, and PTY routes.
        WindowGroup("Nexus Dashboard", id: "dashboard") {
            AppNavigation()
                .environmentObject(viewModel)
        }
        .windowResizability(.contentMinSize)

        Settings {
            PreferencesScene()
                .environmentObject(viewModel)
        }
    }
}
