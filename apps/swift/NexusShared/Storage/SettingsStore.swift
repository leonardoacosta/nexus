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

    // MARK: - Meds sidecar (src-meds, mx-jc0k)

    // The meds CRUD sidecar is a SEPARATE homelab service. By default
    // NexusClient+Meds derives the host from `NexusEndpoint.resolved` and hits
    // it on `medsPort` (8802). Set a full `medsBaseURL` to override the entire
    // URL (host + port + scheme) — e.g. when the sidecar runs elsewhere.
    /// Full base-URL override for the meds sidecar (e.g.
    /// `http://100.73.182.4:8802`). When nil, the host is derived from the
    /// dashboard endpoint and `medsPort` is appended.
    public var medsBaseURL: String? {
        get { defaults.string(forKey: Keys.medsBaseURL) }
        set { defaults.set(newValue, forKey: Keys.medsBaseURL) }
    }

    /// Port the meds sidecar listens on. Defaults to 8802; overridable so a
    /// relocated sidecar does not need a full-URL override.
    public var medsPort: Int {
        get {
            let v = defaults.integer(forKey: Keys.medsPort)
            return v == 0 ? 8802 : v
        }
        set { defaults.set(newValue, forKey: Keys.medsPort) }
    }

    /// Optional bearer token for the meds sidecar. When set, requests carry
    /// `Authorization: Bearer <token>`; when nil, no auth header (tailnet-trust).
    public var medsToken: String? {
        get { defaults.string(forKey: Keys.medsToken) }
        set { defaults.set(newValue, forKey: Keys.medsToken) }
    }

    // MARK: - Plaid control sidecar (src-finance, mx-dhhj)

    // The Plaid control sidecar is a SEPARATE homelab service (port 8801),
    // distinct from the agent API (:7400) and the meds sidecar (:8802). By
    // default NexusClient+Plaid derives the host from `NexusEndpoint.resolved`
    // and hits it on `plaidControlPort` (8801). Set a full `plaidControlBaseURL`
    // to override the entire URL (host + port + scheme). Mirrors the meds knobs.
    /// Full base-URL override for the Plaid control sidecar (e.g.
    /// `http://100.73.182.4:8801`). When nil, the host is derived from the
    /// dashboard endpoint and `plaidControlPort` is appended.
    public var plaidControlBaseURL: String? {
        get { defaults.string(forKey: Keys.plaidControlBaseURL) }
        set { defaults.set(newValue, forKey: Keys.plaidControlBaseURL) }
    }

    /// Port the Plaid control sidecar listens on. Defaults to 8801; overridable
    /// so a relocated sidecar does not need a full-URL override.
    public var plaidControlPort: Int {
        get {
            let v = defaults.integer(forKey: Keys.plaidControlPort)
            return v == 0 ? 8801 : v
        }
        set { defaults.set(newValue, forKey: Keys.plaidControlPort) }
    }

    /// Optional bearer token for the Plaid control sidecar. When set, requests
    /// carry `Authorization: Bearer <token>`; when nil, no auth header
    /// (tailnet-trust).
    public var plaidControlToken: String? {
        get { defaults.string(forKey: Keys.plaidControlToken) }
        set { defaults.set(newValue, forKey: Keys.plaidControlToken) }
    }

    // MARK: - Keys

    private enum Keys {
        static let ttsEnabled            = "nx.tts.enabled"
        static let ttsProvider           = "nx.tts.provider"
        static let elevenLabsVoiceId     = "nx.tts.elevenlabs.voiceId"
        static let processProbeFallback  = "nx.menubar.fallback.processProbe"
        static let dashboardEndpoint     = "nexus.dashboard.endpoint"
        static let medsBaseURL           = "nexus.meds.baseURL"
        static let medsPort              = "nexus.meds.port"
        static let medsToken             = "nexus.meds.token"
        static let plaidControlBaseURL   = "nexus.plaid.baseURL"
        static let plaidControlPort      = "nexus.plaid.port"
        static let plaidControlToken     = "nexus.plaid.token"
    }
}
