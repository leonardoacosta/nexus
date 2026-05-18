// SettingsStore — UserDefaults-backed preferences shared across Apple targets.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.5)
//
// Pair with `Keychain` for secrets. SettingsStore lives in UserDefaults
// because: (a) preferences should round-trip across app restarts, (b) iOS
// Settings.app integration uses UserDefaults, (c) watchOS shares the
// container with the host iOS app.
//
// Wrapping UserDefaults behind a typed surface gives us:
//   - One place to migrate when a key is renamed.
//   - Easy stubbing in tests via inject-on-init.

import Foundation

public final class SettingsStore: @unchecked Sendable {
    public static let shared = SettingsStore()

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - TTS preferences

    public var ttsEnabled: Bool {
        get { (defaults.object(forKey: Keys.ttsEnabled) as? Bool) ?? true }
        set { defaults.set(newValue, forKey: Keys.ttsEnabled) }
    }

    public var ttsProvider: String {
        get { defaults.string(forKey: Keys.ttsProvider) ?? "elevenlabs" }
        set { defaults.set(newValue, forKey: Keys.ttsProvider) }
    }

    public var elevenLabsVoiceId: String? {
        get { defaults.string(forKey: Keys.elevenLabsVoiceId) }
        set { defaults.set(newValue, forKey: Keys.elevenLabsVoiceId) }
    }

    // MARK: - Diagnostics

    public var processProbeFallback: Bool {
        get { defaults.bool(forKey: Keys.processProbeFallback) }
        set { defaults.set(newValue, forKey: Keys.processProbeFallback) }
    }

    // MARK: - Dashboard endpoint

    // INTERIM (nx-4ohfs): single-endpoint override so the dashboard can be
    // pointed at a healthy peer agent (e.g. homelab over Tailscale) instead
    // of the hardcoded localhost agent. Replaced by proper agents.toml
    // multi-agent aggregation later.
    // TODO(nx-4ohfs): surface this in PreferencesScene as an editable field,
    // and extend to a list of endpoints once aggregation lands.
    public var dashboardEndpoint: String? {
        get { defaults.string(forKey: Keys.dashboardEndpoint) }
        set { defaults.set(newValue, forKey: Keys.dashboardEndpoint) }
    }

    // MARK: - Keys

    private enum Keys {
        static let ttsEnabled            = "nx.tts.enabled"
        static let ttsProvider           = "nx.tts.provider"
        static let elevenLabsVoiceId     = "nx.tts.elevenlabs.voiceId"
        static let processProbeFallback  = "nx.menubar.fallback.processProbe"
        static let dashboardEndpoint     = "nexus.dashboard.endpoint"
    }
}
