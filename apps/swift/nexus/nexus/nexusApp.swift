//
//  nexusApp.swift
//  nexus
//
//  Menu bar client for the Nexus agent (peer-to-peer Claude Code session monitor).
//  Replaces the Xcode SwiftUI+SwiftData template with a `MenuBarExtra(.window)`
//  scene + separate `Settings` scene per design.md §A1/A6/A7.
//

import SwiftUI

@main
struct nexusApp: App {
    @StateObject private var viewModel = NexusViewModel.shared

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
