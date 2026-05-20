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
import UserNotifications
import os.log

@main
struct nexusApp: App {
    @StateObject private var viewModel = NexusViewModel.shared

    // TTS observer — mounted in @main init() so the NotificationFired SSE
    // subscription starts window-independently. Pre-`mac-tts-runtime-wire-up`
    // this wiring lived in NotificationsView.task and never fired under
    // LSUIElement (no window mounted on launch → TTS silently dead since
    // 2026-05-16, bd:nx-smger).
    @StateObject private var ttsObserver: TTSObserver

    // App-init logger — same subsystem as TTSObserver so Console.app's
    // `process:nexus` filter shows the launch trace alongside the pipeline.
    private static let appLogger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "NexusApp"
    )

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

        // Request notification authorisation once at launch. The completion
        // handler is non-blocking — macOS caches the user's decision, so
        // subsequent launches return the cached state without re-prompting.
        // Banners are required for the TTS pipeline's first stage (post
        // banner BEFORE attempting synth). Audio still plays without
        // authorisation; only the visual banner is gated.
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound]
        ) { granted, error in
            if let error {
                Self.appLogger.error(
                    "NexusApp: UN authorization request failed error=\(String(describing: error), privacy: .public)"
                )
            } else {
                Self.appLogger.info(
                    "NexusApp: UN authorization granted=\(granted, privacy: .public)"
                )
            }
        }

        // Build TTSObserver with a freshly-constructed aggregate client
        // (matches the per-view pattern used elsewhere in nexus-mac —
        // NexusAggregateClient is cheap, stateless config). AudioPlayer
        // conforms to MP3PlayerProtocol via the extension in
        // nexus-mac/Sources/AudioPlayer.swift, so passing `.shared` wires
        // the cross-platform observer to the macOS-only AVAudioPlayer
        // surface without leaking the dependency into NexusShared.
        let aggregateClient = NexusAggregateClient()
        let observer = TTSObserver(
            client: aggregateClient,
            audioPlayer: AudioPlayer.shared
        )
        _ttsObserver = StateObject(wrappedValue: observer)

        // Kick off the subscription at @main scope — NOT a view `.task`.
        // Under LSUIElement no window is mounted on launch and a view-
        // attached `.task` would never fire. This Task captures the
        // observer reference directly (StateObject's wrappedValue is the
        // same instance) so the subscription begins immediately.
        Self.appLogger.info("NexusApp: starting TTSObserver subscription")
        Task { @MainActor in
            await observer.start()
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
