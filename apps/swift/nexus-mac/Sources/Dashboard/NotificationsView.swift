// NotificationsViewModel + NotificationHistoryRow — retained notification
// history model + row, re-homed into the ambient notification drawer.
//
// Spec: openspec/changes/refocus-board-shell (task 3.5)
//
// The `NotificationsView` tab was deleted (design § 03: notifications become
// the ambient ticker + drawer, never a destination). Its data model
// (`NotificationsViewModel` — SSE backfill + live subscribe + meeting-mode /
// drop-non-critical persistence) and its row (`NotificationHistoryRow` —
// per-row replay) survive here and are consumed by `NotificationDrawer`
// (task 3.3). The view-specific sort/group helpers went with the tab.

import SwiftUI
import NexusShared

/// Sort mode for notification history. Retained because the surviving
/// `SettingsNotificationsView` (General settings tab) persists it via
/// `@AppStorage`; the drawer itself renders newest-first without a picker.
enum NotificationSortMode: String, CaseIterable, Identifiable {
    case time
    case project
    case session

    var id: String { rawValue }

    var label: String {
        switch self {
        case .time:    return "Time"
        case .project: return "Project"
        case .session: return "Session"
        }
    }
}

/// One notification-history row: emoji/bell, title/body, session/project/time
/// chips, and a replay button when the agent cached the MP3. Internal (was
/// private) so `NotificationDrawer` can render it.
struct NotificationHistoryRow: View {
    let event: NotificationEvent
    let player: MP3PlayerProtocol?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if let emoji = event.emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.title3)
            } else {
                Image(systemName: "bell.fill")
                    .foregroundStyle(.secondary)
                    .padding(.top, 3)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let title = event.title, !title.isEmpty {
                    Text(title)
                        .font(.system(.body, design: .monospaced))
                }
                Text(event.body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                HStack(spacing: 6) {
                    if let sessionName = event.sessionName, !sessionName.isEmpty {
                        Text(sessionName)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    if let channel = event.channel {
                        Text(channel)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    if let project = event.project, !project.isEmpty {
                        Text(project)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    Text(event.receivedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if event.audioAvailable == true {
                NotificationReplayButton(
                    notificationId: event.id.uuidString,
                    audioAvailable: true,
                    player: player
                )
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }
}

@MainActor
final class NotificationsViewModel: ObservableObject {
    @Published private(set) var history: [NotificationEvent] = []
    /// Mirrors `SettingsStore.ttsEnabled` (UserDefaults `nx.tts.enabled`) so the
    /// drawer's TTS toggle persists to the agent like every other toggle here,
    /// instead of only writing local defaults. Spec:
    /// openspec/changes/fix-swift-tts-audit-defects (task 1.2).
    @Published var ttsEnabled: Bool = true
    @Published var meetingMode: Bool = false
    @Published var signalOnly: Bool = false
    @Published var suppressionMinutes: Int = 0
    @Published var ducking: DuckingMode = .mix
    @Published private(set) var persistStatus: String?
    @Published var elevenLabsKeyState: ElevenLabsKeyState = .unknown
    @Published var elevenLabsPopover: Bool = false

    /// Player handle threaded into row replay buttons.
    let audioPlayer: MP3PlayerProtocol? = AudioPlayer.shared

    let client = NexusShared.NexusAggregateClient()
    // Settings writes go through the single-endpoint NexusClient (matching
    // SettingsRoutingView) so persist() can inspect the PATCH result (`Data?`,
    // nil on failure) and surface a real error — the aggregate client is
    // fire-and-forget (returns Void, no failure signal). Qualify
    // NexusShared.NexusClient: the nexus-mac target also compiles a legacy
    // `actor NexusClient` an unqualified name would bind to (same footgun
    // documented in SettingsRoutingView / SourceIndexView).
    private let settingsClient = NexusShared.NexusClient()
    private var sseTask: Task<Void, Never>?

    private enum Keys {
        static let meetingMode      = "nx.notifications.meetingMode"
        static let signalOnly       = "nx.notifications.signalOnly"
        static let suppressionMin   = "nx.notifications.suppressionMinutes"
        static let ducking          = "elevenlabs.ducking"
    }

    init() {
        let defaults = UserDefaults.standard
        ttsEnabled = SettingsStore.shared.ttsEnabled
        meetingMode = defaults.bool(forKey: Keys.meetingMode)
        signalOnly = defaults.bool(forKey: Keys.signalOnly)
        suppressionMinutes = max(0, defaults.integer(forKey: Keys.suppressionMin))
        if let raw = defaults.string(forKey: Keys.ducking),
           let mode = DuckingMode(rawValue: raw) {
            ducking = mode
        }
        elevenLabsKeyState = Self.detectInitialKeyState()
    }

    func toggleElevenLabsPopover() {
        elevenLabsPopover.toggle()
    }

    static func detectInitialKeyState() -> ElevenLabsKeyState {
        let key = (try? Keychain.get(KeychainAccount.elevenLabsApiKey)) ?? ""
        return key.isEmpty ? .noKey : .keySet
    }

    func start() async {
        sseTask?.cancel()
        sseTask = Task { [weak self] in
            guard let self else { return }
            // nx-9mt43: backfill historical rows from GET /notifications BEFORE
            // subscribing to live SSE so the drawer shows past rows immediately.
            let historical = await self.client.fetchNotifications()
            if !historical.isEmpty {
                await self.prependBatch(historical)
            }
            await self.client.consumeNotifications { [weak self] ev in
                await self?.prepend(ev)
            }
        }
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
    }

    func clearHistory() {
        history.removeAll()
    }

    private func prepend(_ ev: NotificationEvent) {
        history.insert(ev, at: 0)
        if history.count > 100 {
            history.removeLast(history.count - 100)
        }
    }

    private func prependBatch(_ events: [NotificationEvent]) {
        if history.isEmpty {
            history = Array(events.prefix(100))
            return
        }
        var seen = Set(history.map(\.id))
        for ev in events where !seen.contains(ev.id) {
            history.append(ev)
            seen.insert(ev.id)
        }
        history.sort { $0.receivedAt > $1.receivedAt }
        if history.count > 100 {
            history.removeLast(history.count - 100)
        }
    }

    func persist() {
        let defaults = UserDefaults.standard
        // Writes UserDefaults `nx.tts.enabled` — the same key the drawer's
        // @AppStorage and TTSObserver's SettingsStore read, so the local
        // observer still reacts instantly.
        SettingsStore.shared.ttsEnabled = ttsEnabled
        defaults.set(meetingMode, forKey: Keys.meetingMode)
        defaults.set(signalOnly, forKey: Keys.signalOnly)
        defaults.set(suppressionMinutes, forKey: Keys.suppressionMin)
        defaults.set(ducking.rawValue, forKey: Keys.ducking)
        // snake_case keys the agent's ALLOWED_KEYS actually accepts
        // (meeting_mode / signal_only / suppression_minutes — landed in the API
        // batch, commit cbafe466). The prior camelCase keys 400'd on every
        // call, a silent failure the UI masked by unconditionally flashing
        // "Saved". Inspect the PATCH result and surface a real error on failure,
        // matching SettingsRoutingView's status-flash pattern.
        let body = persistBody()
        Task { [settingsClient] in
            let result = await settingsClient.patchNotificationSettings(body)
            await MainActor.run { self.flash(result == nil ? "Save failed" : "Saved") }
        }
    }

    /// The PATCH body `persist()` sends. `internal` (not inlined) so
    /// nexus-mac-Tests can assert the wire keys directly — the view model wires
    /// its own private NexusClient with no injection seam, the same test-seam
    /// convention SettingsTtsViewModel.duckingWire uses.
    func persistBody() -> [String: Any] {
        [
            "tts_enabled": ttsEnabled,
            "meeting_mode": meetingMode,
            "signal_only": signalOnly,
            "suppression_minutes": suppressionMinutes,
        ]
    }

    /// Flash a transient save/error status, mirroring SettingsRoutingView.flash.
    private func flash(_ msg: String) {
        persistStatus = msg
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            persistStatus = nil
        }
    }
}
