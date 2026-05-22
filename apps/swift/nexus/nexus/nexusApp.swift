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

    // Cross-platform multi-agent observer — hoisted from
    // AppNavigation's @StateObject so SSE subscription begins at @main
    // scope, not when the dashboard Window's view tree mounts. SwiftUI
    // Window scenes lazy-mount their content (the OS may defer view
    // instantiation until focus arrives), so a view-attached
    // `.task { observer.startStreams() }` left the dashboard silent on
    // cold launch — zero TCP sockets to homelab until the user clicked
    // the menu bar item (bd:nx-q7lmb). AppNavigation now receives this
    // observer via init parameter and keeps its `.task` call as a
    // defensive idempotent retry (`startStreams()` short-circuits when
    // `sseTask` is already running).
    @StateObject private var sessionObserver: SessionObserver

    // Strong reference to the UN delegate — `UNUserNotificationCenter`
    // stores the delegate as a `weak` reference, so without an owner the
    // delegate would be released between init() and the first banner
    // click. Mounted alongside TTSObserver so its lifetime matches the
    // app's. Spec: openspec/changes/adopt-reaper-into-nx-cron task 3.3.
    private let activationHandler = NotificationActivationHandler()

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
    // XCUITest seam (spec add-fullstack-integration-test-gate 2.2–2.4,
    // bd:nx-68ulr / bd:nx-2pmzs). The `-uitest-open-dashboard` launch
    // argument is no longer load-bearing: the dashboard `Window` now
    // unconditionally uses `.defaultLaunchBehavior(.presented)` so a
    // fresh launch always surfaces the dashboard (LSUIElement=false in
    // project.yml — "Leo's workflow needs Cmd-Tab to bring the
    // dashboard forward without hunting"). The XCUITest harness
    // continues to pass the flag, harmlessly, as documentation that the
    // test is launching the GUI surface.

    init() {
        if SettingsStore.shared.dashboardEndpoint == nil {
            SettingsStore.shared.dashboardEndpoint = "http://100.73.182.4:7400"
        }

        // settings-tab-redesign task 2.11 (bd:nx-s76uz):
        // Observational migration check — log warn when an expected
        // @AppStorage / Keychain key is absent post-redesign. NO mutation;
        // a regression should surface as a log line, not a settings reset.
        Self.runSettingsKeyMigrationCheck()

        // Mount the activation handler BEFORE requesting authorisation
        // so a queued banner-click activation that arrives during the
        // authorisation prompt still routes through our logPath handler.
        // The delegate is held by `activationHandler` (strong), then
        // assigned weakly to UNUserNotificationCenter per Apple's API
        // contract. Spec: openspec/changes/adopt-reaper-into-nx-cron 3.3.
        UNUserNotificationCenter.current().delegate = activationHandler

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

        // Hoist the dashboard's SessionObserver to App scope and start
        // its SSE + polling pumps immediately (bd:nx-q7lmb). The
        // previous wiring lived in `AppNavigation.task`, which only
        // fires when the dashboard Window's view tree actually mounts —
        // SwiftUI Window scenes lazy-mount, so cold launches reliably
        // showed ZERO TCP sockets to homelab until the user clicked the
        // menu bar item. By owning the observer here we guarantee the
        // multi-agent SSE consumer is alive the instant the app
        // process is, independent of any window/view lifecycle.
        let session = SessionObserver()
        _sessionObserver = StateObject(wrappedValue: session)
        Self.appLogger.info("NexusApp: starting SessionObserver streams")
        Task { @MainActor in
            session.startStreams()
            await session.refreshSessions()
        }

        // Same defense for the menu-bar popover client. Pre-fix this
        // was only started from `NexusPanel.onAppear` — the popover
        // mounts only when the menu bar item is clicked open, so the
        // legacy `NexusClient` SSE pump (sessions, notifications,
        // heartbeat) was silent until first interaction. `startStreams()`
        // is idempotent, so the popover's `onAppear` call remains as a
        // harmless retry.
        Self.appLogger.info("NexusApp: starting NexusViewModel.shared streams")
        Task { @MainActor in
            NexusViewModel.shared.startStreams()
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
            AppNavigation(observer: sessionObserver)
                .environmentObject(viewModel)
        }
        // Always present the dashboard at launch (bd:nx-2pmzs). The
        // `uiTestOpensDashboard` arg is preserved for harness
        // documentation but is no longer load-bearing — the modifier
        // unconditionally applies `.presented`.
        .uiTestLaunchBehavior(presentAtLaunch: true)
    }
}

private extension nexusApp {
    /// Settings persistence-key migration audit (task 2.11). Enumerates
    /// every @AppStorage / Keychain key the redesigned Settings pane
    /// expects to read; emits `warning` (NOT mutation) for each absent
    /// key so a silent regression surfaces in the launch trace.
    static func runSettingsKeyMigrationCheck() {
        let defaults = UserDefaults.standard

        // Keys that MAY legitimately be unset on a fresh install — track
        // them anyway so the log captures the post-redesign baseline.
        let expectedDefaults: [String] = [
            "elevenlabs.ducking",              // SettingsTtsView
            "nx.notifications.signalOnly",     // SettingsTtsView / NotificationsView
            "nx.tts.enabled",                  // SettingsStore.ttsEnabled
            "nx.notifications.bannerEnabled",  // SettingsTtsView + SettingsNotificationsView
            "notifications.sort",              // SettingsNotificationsView
            "notifications.group",             // SettingsNotificationsView
            "notifications.replay.autoplay",   // SettingsNotificationsView (new)
            "nx.dashboard.refreshSeconds",     // SettingsDashboardView
            "nx.dashboard.defaultView",        // SettingsDashboardView
            "nx.dashboard.theme",              // SettingsDashboardView (new)
            "nx.dashboard.accentHex",          // SettingsDashboardView (new)
            "nx.dashboard.fontScale",          // SettingsDashboardView (new)
            "settings.sidebar.selection"       // SettingsView shell
        ]
        for key in expectedDefaults {
            if defaults.object(forKey: key) == nil {
                appLogger.warning(
                    "settings-migration: expected default key '\(key, privacy: .public)' not present"
                )
            }
        }
        let expectedKeychain = [
            KeychainAccount.elevenLabsApiKey,
            KeychainAccount.elevenLabsVoiceId
        ]
        for account in expectedKeychain {
            if (try? Keychain.get(account)) == nil {
                appLogger.warning(
                    "settings-migration: expected Keychain account '\(account, privacy: .public)' not present"
                )
            }
        }
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
