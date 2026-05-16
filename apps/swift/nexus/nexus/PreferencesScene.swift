//
//  PreferencesScene.swift
//  nexus
//
//  Settings window registered alongside the `MenuBarExtra` scene. All values
//  are persisted via `@AppStorage` against the `com.nexus.menubar` suite.
//

import SwiftUI

extension UserDefaults {
    /// Convenience handle for the menu bar suite.
    static let nx: UserDefaults = UserDefaults(suiteName: "com.nexus.menubar") ?? .standard
}

enum PrefsKey {
    static let firstRun         = "nx.menubar.firstRun"
    static let autostart        = "nx.menubar.autostart"
    static let ttsProvider      = "nx.menubar.ttsProvider"
    static let ttsVoice         = "nx.menubar.ttsVoice"
    static let summonHotkey     = "nx.menubar.hotkey.summon"
    static let spawnHotkey      = "nx.menubar.hotkey.spawn"
    static let muteHotkey       = "nx.menubar.hotkey.mute"
    static let testHotkey       = "nx.menubar.hotkey.test"
    static let themeDensity     = "nx.menubar.themeDensity"
    static let processProbeFallback = "nx.menubar.fallback.processProbe"
}

struct PreferencesScene: View {
    @EnvironmentObject private var vm: NexusViewModel
    @AppStorage(PrefsKey.autostart, store: .nx) private var autostart = false
    @AppStorage(PrefsKey.ttsProvider, store: .nx) private var ttsProvider = "elevenlabs"
    @AppStorage(PrefsKey.ttsVoice, store: .nx) private var ttsVoice = ""
    @AppStorage(PrefsKey.summonHotkey, store: .nx) private var summonHotkey = "⌃⌥N"
    @AppStorage(PrefsKey.spawnHotkey, store: .nx) private var spawnHotkey = "⌃⌥H"
    @AppStorage(PrefsKey.muteHotkey, store: .nx) private var muteHotkey = "⌘M"
    @AppStorage(PrefsKey.testHotkey, store: .nx) private var testHotkey = "⌘T"
    @AppStorage(PrefsKey.themeDensity, store: .nx) private var themeDensity = "regular"
    // Diagnostics fallback — read by `NexusViewModel.maybeAugmentWithProbe()`
    // via `UserDefaults.standard.bool(forKey:)`, so this toggle MUST write to
    // `.standard` (not the `.nx` suite) to be observable from there.
    @AppStorage(PrefsKey.processProbeFallback) private var processProbeFallback = false

    var body: some View {
        TabView {
            generalTab
                .tabItem { Label("General", systemImage: "gearshape") }
            hotkeysTab
                .tabItem { Label("Hotkeys", systemImage: "keyboard") }
            ttsTab
                .tabItem { Label("TTS", systemImage: "waveform") }
            diagnosticsTab
                .tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }
        .padding(20)
        .frame(width: 460, height: 360)
    }

    private var generalTab: some View {
        Form {
            Section("Startup") {
                Toggle("Launch Nexus at login", isOn: Binding(
                    get: { autostart },
                    set: { newValue in
                        autostart = newValue
                        if newValue { AutostartInstaller.install() }
                        else        { AutostartInstaller.uninstall() }
                    }
                ))
            }
            Section("Theme") {
                Picker("Density", selection: $themeDensity) {
                    Text("Compact").tag("compact")
                    Text("Regular").tag("regular")
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private var hotkeysTab: some View {
        Form {
            TextField("Summon panel", text: $summonHotkey)
            TextField("Spawn homelab session", text: $spawnHotkey)
            TextField("Toggle mute (panel)", text: $muteHotkey)
            TextField("Test voice (panel)", text: $testHotkey)
            Text("Hotkeys take effect on next launch. ⌃ = control, ⌥ = option, ⌘ = command.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var ttsTab: some View {
        Form {
            Picker("Default provider", selection: $ttsProvider) {
                Text("ElevenLabs").tag("elevenlabs")
                Text("Local say()").tag("say")
            }
            TextField("Default voice ID (ElevenLabs)", text: $ttsVoice)
            Button("Send test phrase") {
                Task { await vm.testVoice() }
            }
        }
    }

    private var diagnosticsTab: some View {
        Form {
            Section("Fallbacks") {
                Toggle("SSH probe fallback", isOn: $processProbeFallback)
                Text("Bypass the agent and SSH-probe homelab when the agent returns no real sessions. Off by default; turn on if the agent isn't tracking your processes.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
