// SettingsTtsView — consolidated TTS & ElevenLabs pane.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.2, bd:nx-oiam3)
//
// Four blocks (in render order):
//   1. TTS toggles  — tts_enabled, banner_enabled, ducking, signal-only.
//      All persistence keys preserved verbatim from the pre-redesign
//      SettingsViewModel + NotificationsView so existing user prefs
//      survive the refactor.
//   2. ElevenLabs key — masked-show field for the current Keychain key,
//      a paste field for replacement, Save + Test buttons.
//   3. Global voice id — text field backed by Keychain.elevenLabsVoiceId.
//   4. Per-project voices — ProjectVoicesView mounted inline (from
//      notifications-overhaul). Append-only composition.

import SwiftUI
import NexusShared

/// All persistence keys for the TTS pane. Mirrors the constants used in
/// the legacy SettingsViewModel + NotificationsView so a one-character
/// typo here would surface immediately on relaunch (existing pref vanishes).
enum SettingsTtsKeys {
    static let ducking      = "elevenlabs.ducking"               // SettingsViewModel
    static let signalOnly   = "nx.notifications.signalOnly"      // NotificationsView/SettingsVM (shared)
    static let ttsEnabled   = "nx.tts.enabled"                   // SettingsStore.ttsEnabled
    static let banner       = "nx.notifications.bannerEnabled"   // NEW (notifications-overhaul prefix)
}

@MainActor
final class SettingsTtsViewModel: ObservableObject {
    @Published var ttsEnabled: Bool = true
    @Published var bannerEnabled: Bool = true
    @Published var signalOnly: Bool = false
    @Published var ducking: DuckingMode = .mix

    @Published var apiKeyMaskedDisplay: String = "—"
    @Published var pasteApiKey: String = ""
    @Published var voiceId: String = ""
    @Published var status: String?
    @Published var statusIsError: Bool = false

    private let store: SettingsStore = .shared
    // Qualify the SHARED client — the nexus-mac target also compiles a legacy
    // `actor NexusClient` (apps/swift/nexus/nexus/NexusClient.swift) that an
    // unqualified `NexusClient` would bind to (it lacks these methods). Same
    // footgun documented in SettingsRoutingView / SourceIndexView.
    private let client: NexusShared.NexusClient = NexusShared.NexusClient()

    init() {
        load()
    }

    func load() {
        let defaults = UserDefaults.standard
        ttsEnabled = store.ttsEnabled
        bannerEnabled = (defaults.object(forKey: SettingsTtsKeys.banner) as? Bool) ?? true
        signalOnly = defaults.bool(forKey: SettingsTtsKeys.signalOnly)
        if let raw = defaults.string(forKey: SettingsTtsKeys.ducking),
           let mode = DuckingMode(rawValue: raw) {
            ducking = mode
        } else {
            ducking = .mix
        }
        voiceId = (try? Keychain.get(KeychainAccount.elevenLabsVoiceId)) ?? ""
        apiKeyMaskedDisplay = Self.maskedKey()
    }

    static func maskedKey() -> String {
        let raw = (try? Keychain.get(KeychainAccount.elevenLabsApiKey)) ?? ""
        guard !raw.isEmpty else { return "—" }
        if raw.count <= 8 { return String(repeating: "•", count: raw.count) }
        return String(raw.prefix(4)) + "…" + String(raw.suffix(2))
    }

    func persistToggles() {
        // Local optimistic write first, then PATCH the agent — mirrors
        // SettingsRoutingView.persistSettings() (sync-notification-settings-
        // round-trip, task 3.1). Peer machines / this listener after an agent
        // restart only learn about the change via the server round trip.
        let defaults = UserDefaults.standard
        store.ttsEnabled = ttsEnabled
        defaults.set(bannerEnabled, forKey: SettingsTtsKeys.banner)
        defaults.set(signalOnly, forKey: SettingsTtsKeys.signalOnly)
        defaults.set(ducking.rawValue, forKey: SettingsTtsKeys.ducking)
        let body: [String: Any] = [
            "tts_enabled": ttsEnabled,
            "banner_enabled": bannerEnabled,
            "ducking_mode": Self.duckingWire(ducking),
            "signal_only": signalOnly,
        ]
        Task {
            _ = await client.patchNotificationSettings(body)
            await MainActor.run { self.flash("TTS settings saved") }
        }
    }

    /// Bridge the Mac's ducking vocabulary (duck/mix/pause — the volume-dip
    /// depth, see `duckingCaption`) to the agent's `ducking_mode` column, which
    /// only accepts `full`/`half`/`mute` (notification-settings.ts DUCKING_MODES;
    /// any other value 400s the whole PATCH). mix = no dip = full; duck = ~40%
    /// dip = half; pause = ~15% near-silence = mute.
    private static func duckingWire(_ mode: DuckingMode) -> String {
        switch mode {
        case .mix:   return "full"
        case .duck:  return "half"
        case .pause: return "mute"
        }
    }

    func saveKey() {
        do {
            if pasteApiKey.isEmpty {
                try Keychain.delete(KeychainAccount.elevenLabsApiKey)
            } else {
                try Keychain.set(pasteApiKey, for: KeychainAccount.elevenLabsApiKey)
            }
            if voiceId.isEmpty {
                try Keychain.delete(KeychainAccount.elevenLabsVoiceId)
            } else {
                try Keychain.set(voiceId, for: KeychainAccount.elevenLabsVoiceId)
            }
            pasteApiKey = ""
            apiKeyMaskedDisplay = Self.maskedKey()
            flash("Saved")
        } catch {
            statusMessage("Save failed: \(error)", isError: true)
        }
    }

    func test() {
        Task {
            do {
                let client = ElevenLabsClient()
                let data = try await client.synthesize(
                    ElevenLabsSynthRequest(
                        text: "Nexus configuration test.",
                        voiceId: voiceId
                    )
                )
                try AudioPlayer.shared.play(mp3Data: data, ducking: ducking)
                flash("Test playback dispatched")
            } catch {
                statusMessage("Test failed: \(error)", isError: true)
            }
        }
    }

    private func flash(_ msg: String) {
        statusMessage(msg, isError: false)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            status = nil
        }
    }

    private func statusMessage(_ msg: String, isError: Bool) {
        status = msg
        statusIsError = isError
    }
}

struct SettingsTtsView: View {
    @StateObject private var model = SettingsTtsViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                togglesSection
                Divider()
                keyPanel
                Divider()
                voiceIdField
                Divider()
                ProjectVoicesView()
                if let status = model.status {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(model.statusIsError ? .red : .green)
                }
                Spacer(minLength: 12)
            }
            .padding(20)
        }
    }

    private var togglesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Audio output").font(.headline)
            Toggle("TTS enabled", isOn: $model.ttsEnabled)
                .onChange(of: model.ttsEnabled) { _, _ in model.persistToggles() }
            Toggle("Show notification banner", isOn: $model.bannerEnabled)
                .onChange(of: model.bannerEnabled) { _, _ in model.persistToggles() }
            Toggle("Signal-only mode (no spoken body)", isOn: $model.signalOnly)
                .onChange(of: model.signalOnly) { _, _ in model.persistToggles() }
            Picker("Ducking", selection: $model.ducking) {
                Text("Mix").tag(DuckingMode.mix)
                Text("Duck").tag(DuckingMode.duck)
                Text("Quiet").tag(DuckingMode.pause)
            }
            .onChange(of: model.ducking) { _, _ in model.persistToggles() }
            // nx-5bqus: describe the three modes' actual behaviour (documented
            // in AudioPlayer.swift / MP3Player.swift). macOS has no per-app
            // output volume, so Duck/Quiet dip the SYSTEM output volume for the
            // clip and restore it after.
            Text(duckingCaption)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Behavioural summary for the selected ducking mode. Kept in sync with
    /// the volume targets in AudioPlayer.applyDuck (~40% duck / ~15% quiet).
    private var duckingCaption: String {
        switch model.ducking {
        case .mix:
            return "Mix — TTS plays at full volume over other audio; no system volume change."
        case .duck:
            return "Duck — system output volume dips to ~40% for the clip, then restores."
        case .pause:
            return "Quiet — system output volume dips to ~15% (near-silence) for the clip, then restores."
        }
    }

    private var keyPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ElevenLabs API key").font(.headline)
            HStack {
                Text("Current:")
                    .foregroundStyle(.secondary)
                Text(model.apiKeyMaskedDisplay)
                    .font(.system(.body, design: .monospaced))
            }
            SecureField("Paste new API key here", text: $model.pasteApiKey)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Save key") {
                    model.saveKey()
                }
                Button("Test playback") {
                    model.test()
                }
                .disabled(model.voiceId.isEmpty)
            }
        }
    }

    private var voiceIdField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Global voice id").font(.headline)
            TextField("ElevenLabs voice id", text: $model.voiceId)
                .textFieldStyle(.roundedBorder)
            Text("Stored in Keychain (`elevenlabs.voice_id`). Per-project overrides below take precedence when set.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
