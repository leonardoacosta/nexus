// SettingsView — macOS dashboard parity for apps/nextjs/src/app/settings.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.8)
// bd:nx-gaquu
//
// Aggregator scene combining four panes:
//   1. TTS (ElevenLabs voice, ducking, signal-only)
//   2. Keychain viewer (read-only — counts entries by service)
//   3. Agent connection (URL, port, last sync)
//   4. Dashboard preferences (refresh interval, default view)
//
// All non-secret values persist via SettingsStore (UserDefaults); the
// ElevenLabs API key is owned by Keychain.swift and is never displayed.

import SwiftUI
import NexusShared

struct SettingsView: View {
    @StateObject private var model = SettingsViewModel()

    var body: some View {
        Form {
            ttsSection
            keychainSection
            agentSection
            dashboardSection
            if let status = model.statusMessage {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(model.statusIsError ? .red : .green)
            }
        }
        .padding(20)
        .task {
            await model.refreshAgentStatus()
        }
    }

    private var ttsSection: some View {
        Section("TTS") {
            HStack {
                Text("ElevenLabs voice ID")
                Spacer()
                Text(model.maskedVoiceId)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Picker("Ducking", selection: $model.ducking) {
                Text("Mix").tag(DuckingMode.mix)
                Text("Duck").tag(DuckingMode.duck)
                Text("Pause others").tag(DuckingMode.pause)
            }
            .onChange(of: model.ducking) { _, _ in model.persistTts() }
            Toggle("Signal-only mode (no spoken body)", isOn: $model.signalOnly)
                .onChange(of: model.signalOnly) { _, _ in model.persistTts() }
            Toggle("TTS enabled", isOn: $model.ttsEnabled)
                .onChange(of: model.ttsEnabled) { _, _ in model.persistTts() }
        }
    }

    private var keychainSection: some View {
        Section("Keychain") {
            HStack {
                Image(systemName: model.elevenLabsKeyConfigured ? "checkmark.seal.fill" : "xmark.seal")
                    .foregroundStyle(model.elevenLabsKeyConfigured ? .green : .secondary)
                Text("ElevenLabs API key")
                Spacer()
                Text(model.elevenLabsKeyConfigured ? "configured" : "missing")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            HStack {
                Image(systemName: model.elevenLabsVoiceConfigured ? "checkmark.seal.fill" : "xmark.seal")
                    .foregroundStyle(model.elevenLabsVoiceConfigured ? .green : .secondary)
                Text("ElevenLabs voice ID")
                Spacer()
                Text(model.elevenLabsVoiceConfigured ? "configured" : "missing")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text("Manage Keychain entries via the legacy Preferences → TTS pane.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var agentSection: some View {
        Section("Agent connection") {
            HStack {
                Text("URL")
                Spacer()
                TextField("http://localhost:7400", text: $model.agentUrl)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
            }
            HStack {
                Circle()
                    .fill(model.agentReachable ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                Text(model.agentReachable ? "reachable" : "unreachable")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                if let synced = model.lastSync {
                    Text("synced \(synced, style: .relative) ago")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Button("Test") {
                    Task { await model.refreshAgentStatus() }
                }
                .buttonStyle(.borderless)
            }
            HStack {
                Spacer()
                Button("Save URL") {
                    model.persistAgentUrl()
                }
                .disabled(model.agentUrl.isEmpty)
            }
        }
    }

    private var dashboardSection: some View {
        Section("Dashboard") {
            HStack {
                Text("Refresh interval")
                Spacer()
                Stepper("\(model.refreshIntervalSeconds)s",
                        value: $model.refreshIntervalSeconds,
                        in: 5...300,
                        step: 5)
                    .onChange(of: model.refreshIntervalSeconds) { _, _ in model.persistDashboard() }
            }
            Picker("Default view", selection: $model.defaultView) {
                Text("Sessions").tag("sessions")
                Text("Projects").tag("projects")
                Text("Specs").tag("specs")
                Text("Health").tag("health")
                Text("Notifications").tag("notifications")
            }
            .onChange(of: model.defaultView) { _, _ in model.persistDashboard() }
        }
    }
}

@MainActor
final class SettingsViewModel: ObservableObject {
    // TTS
    @Published var ducking: DuckingMode = .mix
    @Published var signalOnly: Bool = false
    @Published var ttsEnabled: Bool = true

    // Keychain (read-only flags)
    @Published private(set) var elevenLabsKeyConfigured: Bool = false
    @Published private(set) var elevenLabsVoiceConfigured: Bool = false

    // Agent
    @Published var agentUrl: String = "http://localhost:7400"
    @Published private(set) var agentReachable: Bool = false
    @Published private(set) var lastSync: Date?

    // Dashboard
    @Published var refreshIntervalSeconds: Int = 30
    @Published var defaultView: String = "sessions"

    // Status
    @Published private(set) var statusMessage: String?
    @Published private(set) var statusIsError: Bool = false

    private let store: SettingsStore = .shared

    private enum Keys {
        static let ducking          = "elevenlabs.ducking"
        static let signalOnly       = "nx.notifications.signalOnly"
        static let agentUrl         = "nx.agent.baseUrl"
        static let refreshInterval  = "nx.dashboard.refreshSeconds"
        static let defaultView      = "nx.dashboard.defaultView"
    }

    var maskedVoiceId: String {
        let raw = (try? Keychain.get(KeychainAccount.elevenLabsVoiceId)) ?? ""
        guard !raw.isEmpty else { return "—" }
        if raw.count <= 6 { return raw }
        return String(raw.prefix(4)) + "…" + String(raw.suffix(2))
    }

    init() {
        let defaults = UserDefaults.standard

        if let raw = defaults.string(forKey: Keys.ducking),
           let mode = DuckingMode(rawValue: raw) {
            ducking = mode
        }
        signalOnly = defaults.bool(forKey: Keys.signalOnly)
        ttsEnabled = store.ttsEnabled
        agentUrl = defaults.string(forKey: Keys.agentUrl) ?? "http://localhost:7400"
        let stored = defaults.integer(forKey: Keys.refreshInterval)
        refreshIntervalSeconds = stored > 0 ? stored : 30
        defaultView = defaults.string(forKey: Keys.defaultView) ?? "sessions"

        elevenLabsKeyConfigured = (try? Keychain.get(KeychainAccount.elevenLabsApiKey)) != nil
        elevenLabsVoiceConfigured = (try? Keychain.get(KeychainAccount.elevenLabsVoiceId)) != nil
    }

    func persistTts() {
        let defaults = UserDefaults.standard
        defaults.set(ducking.rawValue, forKey: Keys.ducking)
        defaults.set(signalOnly, forKey: Keys.signalOnly)
        store.ttsEnabled = ttsEnabled
        flash("TTS settings saved")
    }

    func persistDashboard() {
        let defaults = UserDefaults.standard
        defaults.set(refreshIntervalSeconds, forKey: Keys.refreshInterval)
        defaults.set(defaultView, forKey: Keys.defaultView)
        flash("Dashboard preferences saved")
    }

    func persistAgentUrl() {
        UserDefaults.standard.set(agentUrl, forKey: Keys.agentUrl)
        flash("Agent URL saved — restart to apply")
        Task { await refreshAgentStatus() }
    }

    func refreshAgentStatus() async {
        guard let url = URL(string: agentUrl)?.appendingPathComponent("health/history") else {
            agentReachable = false
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 3
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                agentReachable = true
                lastSync = Date()
            } else {
                agentReachable = false
            }
        } catch {
            agentReachable = false
        }
    }

    private func flash(_ msg: String) {
        statusMessage = msg
        statusIsError = false
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            statusMessage = nil
        }
    }
}
