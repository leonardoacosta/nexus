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

    // MARK: - Presence routing (context-aware-routing, nx-rwulm)

    // Local UI state for the Routing settings pane. The three fail/toggle
    // values mirror the agent's `notification_settings` presence columns and
    // round-trip via `PATCH /notifications/settings` (snake_case wire keys);
    // the ordered rules round-trip via `PUT /notifications/routing-rules`.
    // SettingsStore persists the last-known-good copy in UserDefaults so the
    // pane renders instantly before the network fetch lands, and re-PATCHes /
    // re-PUTs the agent on every edit. The agent broadcasts `SettingsChanged`
    // over SSE; the pane re-reads on appear to reflect a fleet-peer edit.

    /// Master switch — when off the agent falls back to today's project +
    /// `meeting_behavior` routing (default false; mirrors the column default).
    public var presenceAwareRouting: Bool {
        get { defaults.bool(forKey: Keys.presenceAwareRouting) }
        set { defaults.set(newValue, forKey: Keys.presenceAwareRouting) }
    }

    /// When a matched rule depends on an `unknown` presence field and the
    /// notification is non-critical: `fail-safe` (demote to silent/digest,
    /// default) vs `fail-open` (deliver anyway).
    public var unknownNoncriticalMode: PresenceFailMode {
        get { PresenceFailMode(rawValue: defaults.string(forKey: Keys.unknownNoncriticalMode) ?? "") ?? .failSafe }
        set { defaults.set(newValue.rawValue, forKey: Keys.unknownNoncriticalMode) }
    }

    /// Critical-notification unknown-presence policy: `fail-open` (deliver
    /// everywhere, default) vs `fail-safe`.
    public var unknownCriticalMode: PresenceFailMode {
        get { PresenceFailMode(rawValue: defaults.string(forKey: Keys.unknownCriticalMode) ?? "") ?? .failOpen }
        set { defaults.set(newValue.rawValue, forKey: Keys.unknownCriticalMode) }
    }

    /// Which presence sources the user has enabled (UI sugar — local only;
    /// the agent reads the vector reporters push, not these toggles). Stored as
    /// the set of enabled `PresenceSource` raw values.
    public var enabledPresenceSources: Set<PresenceSource> {
        get {
            let raws = defaults.stringArray(forKey: Keys.enabledPresenceSources)
                ?? PresenceSource.defaultEnabled.map(\.rawValue)
            return Set(raws.compactMap(PresenceSource.init(rawValue:)))
        }
        set { defaults.set(newValue.map(\.rawValue).sorted(), forKey: Keys.enabledPresenceSources) }
    }

    /// The ordered routing-rule set (index == priority, first-match-wins).
    /// Persisted as JSON so the pane renders the last-known list before the
    /// `GET /notifications/routing-rules` fetch returns. Defaults to the
    /// Phase-1 seed (Rule 1 active-Mac, Rule 2 meeting-hold, terminal).
    public var routingRules: [RoutingRule] {
        get {
            guard let data = defaults.data(forKey: Keys.routingRules),
                  let decoded = try? JSONDecoder().decode([RoutingRule].self, from: data),
                  !decoded.isEmpty
            else { return RoutingRule.phase1Defaults }
            return decoded
        }
        set {
            // Re-stamp priority to array index so a drag-reorder persists order.
            let reindexed = newValue.enumerated().map { idx, rule -> RoutingRule in
                var r = rule
                r.priority = idx
                return r
            }
            if let data = try? JSONEncoder().encode(reindexed) {
                defaults.set(data, forKey: Keys.routingRules)
            }
        }
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
        static let presenceAwareRouting  = "nexus.routing.presenceAware"
        static let unknownNoncriticalMode = "nexus.routing.unknownNoncritical"
        static let unknownCriticalMode   = "nexus.routing.unknownCritical"
        static let enabledPresenceSources = "nexus.routing.sources"
        static let routingRules          = "nexus.routing.rules"
    }
}

// MARK: - Presence routing wire model (context-aware-routing)

/// Unknown-presence policy. Wire values are the agent's snake-with-hyphen
/// literals (`fail-safe` | `fail-open`) — used verbatim in the PATCH body.
public enum PresenceFailMode: String, CaseIterable, Identifiable, Sendable, Codable {
    case failSafe = "fail-safe"
    case failOpen = "fail-open"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .failSafe: return "Fail-safe — silent/digest"
        case .failOpen: return "Fail-open — deliver everywhere"
        }
    }
}

/// A presence source the user can toggle in the pane. UI sugar — the agent
/// reads the vector reporters push, so these toggles gate which reporters the
/// user intends to trust, mirroring the wireframe's PRESENCE SOURCES block.
public enum PresenceSource: String, CaseIterable, Identifiable, Sendable, Codable {
    case macIdleLock        // Mac idle / lock / console
    case meetingDetect      // camera + mic + meeting-app
    case calendarBusy       // EventKit calendar busy
    case focusSleep         // Focus / Sleep (DND)
    case phoneLocation      // iPhone home geofence
    case bedtimeSchedule    // Bedtime from Health schedule

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .macIdleLock:     return "Mac idle / lock / console"
        case .meetingDetect:   return "Meeting detect (camera + mic + app)"
        case .calendarBusy:    return "Calendar busy (EventKit)"
        case .focusSleep:      return "Focus / Sleep (DND)"
        case .phoneLocation:   return "iPhone location (home geofence)"
        case .bedtimeSchedule: return "Bedtime from Health schedule"
        }
    }

    /// Phase-1 sources that need no new OS grant default ON (per wireframe).
    public static let defaultEnabled: [PresenceSource] = [.macIdleLock, .meetingDetect, .focusSleep]
}

/// A single routing rule. Mirrors the agent's `routing_rules` wire shape
/// (`id`, `priority`, `condition`, `action`, `enabled`) — `condition` and
/// `action` are kept as flat string maps here (the Phase-1 rules only need
/// scalar fields), matching the JSONB columns. `priority` is array index.
public struct RoutingRule: Identifiable, Equatable, Hashable, Sendable, Codable {
    public var id: String
    public var priority: Int
    public var label: String
    /// Presence predicate this rule matches on. `nil` values are wildcards.
    public var requireMacActive: Bool?
    public var requireInMeeting: Bool?
    public var requireBedtime: Bool?
    /// Resulting action summary the simulator surfaces + the agent persists.
    public var action: RoutingAction
    public var enabled: Bool

    public init(
        id: String,
        priority: Int,
        label: String,
        requireMacActive: Bool? = nil,
        requireInMeeting: Bool? = nil,
        requireBedtime: Bool? = nil,
        action: RoutingAction,
        enabled: Bool = true
    ) {
        self.id = id
        self.priority = priority
        self.label = label
        self.requireMacActive = requireMacActive
        self.requireInMeeting = requireInMeeting
        self.requireBedtime = requireBedtime
        self.action = action
        self.enabled = enabled
    }

    /// The Phase-1 seed rules (active-Mac, meeting-hold, terminal fallback),
    /// matching `rules-engine.ts` first-match-wins ordering. Rule 1 (active
    /// Mac, not in meeting) sits ABOVE any bedtime rule so an active Mac
    /// speaks even at bedtime (decision Q1).
    public static let phase1Defaults: [RoutingRule] = [
        RoutingRule(
            id: "rule-active-mac",
            priority: 0,
            label: "Mac active, not in meeting -> banner + TTS (mac)",
            requireMacActive: true,
            requireInMeeting: false,
            action: .bannerAndTTS
        ),
        RoutingRule(
            id: "rule-meeting-hold",
            priority: 1,
            label: "In meeting -> HOLD +2m -> summary (mac)",
            requireInMeeting: true,
            action: .holdForMeeting
        ),
        RoutingRule(
            id: "rule-terminal",
            priority: 2,
            label: "Fallback -> dashboard + digest",
            action: .terminalDigest
        ),
    ]
}

/// Closed set of Phase-1 action outcomes the simulator + rules list render.
/// (The agent's `Action` is wider; Phase 1 only ships these three.)
public enum RoutingAction: String, Equatable, Hashable, Sendable, Codable {
    case bannerAndTTS
    case holdForMeeting
    case terminalDigest

    public var summary: String {
        switch self {
        case .bannerAndTTS:   return "banner + TTS (mac)"
        case .holdForMeeting: return "hold +2m -> summary (mac)"
        case .terminalDigest: return "dashboard + digest"
        }
    }
}
