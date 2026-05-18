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

    // MARK: - Keys

    private enum Keys {
        static let ttsEnabled            = "nx.tts.enabled"
        static let ttsProvider           = "nx.tts.provider"
        static let elevenLabsVoiceId     = "nx.tts.elevenlabs.voiceId"
        static let processProbeFallback  = "nx.menubar.fallback.processProbe"
    }
}
