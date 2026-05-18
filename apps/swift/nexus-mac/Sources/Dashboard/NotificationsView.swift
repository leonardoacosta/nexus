// NotificationsView — macOS dashboard parity for apps/nextjs/src/app/notifications.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.7)
// bd:nx-gaquu
//
// Two-pane layout:
//   - Left: live history of NotificationFired events. Subscribes to
//     `NexusClient.consumeNotifications()` and prepends each arrival.
//   - Right: settings (meeting mode toggle, suppression window, ducking
//     mode, signal-only) persisted via SettingsStore.
//
// History is capped at 100 entries to keep the list lightweight; the
// agent's persistent log remains the source of truth.

import SwiftUI
import NexusShared

struct NotificationsView: View {
    @StateObject private var model = NotificationsViewModel()

    var body: some View {
        HSplitView {
            historyPane
                .frame(minWidth: 320, idealWidth: 420)
            settingsPane
                .frame(minWidth: 260, idealWidth: 320)
        }
        .task {
            await model.start()
        }
        .onDisappear {
            model.stop()
        }
    }

    private var historyPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("HISTORY")
                    .font(.system(.caption, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(model.history.count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
                Button {
                    model.clearHistory()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .help("Clear history")
                .disabled(model.history.isEmpty)
            }
            .padding(.horizontal, 14)
            if model.history.isEmpty {
                ContentUnavailableView(
                    "No notifications yet",
                    systemImage: "bell.slash",
                    description: Text("Waiting for the next NotificationFired event…")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.history) { ev in
                            NotificationHistoryRow(event: ev)
                            Divider().padding(.leading, 14)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 8)
    }

    private var settingsPane: some View {
        Form {
            Section("Mode") {
                Toggle("Meeting mode (suppress all)", isOn: $model.meetingMode)
                    .onChange(of: model.meetingMode) { _, _ in model.persist() }
                Toggle("Signal-only (no TTS body)", isOn: $model.signalOnly)
                    .onChange(of: model.signalOnly) { _, _ in model.persist() }
            }
            Section("Suppression") {
                HStack {
                    Text("Window")
                    Spacer()
                    Stepper("\(model.suppressionMinutes)m",
                            value: $model.suppressionMinutes,
                            in: 0...60,
                            step: 1)
                        .onChange(of: model.suppressionMinutes) { _, _ in model.persist() }
                }
                Text("Notifications within \(model.suppressionMinutes) minute(s) of the previous are coalesced.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Audio") {
                Picker("Ducking", selection: $model.ducking) {
                    Text("Mix").tag(DuckingMode.mix)
                    Text("Duck").tag(DuckingMode.duck)
                    Text("Pause others").tag(DuckingMode.pause)
                }
                .onChange(of: model.ducking) { _, _ in model.persist() }
            }
            if let status = model.persistStatus {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.green)
            }
        }
        .padding()
    }
}

private struct NotificationHistoryRow: View {
    let event: NotificationEvent

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
                    if let channel = event.channel {
                        Text(channel)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    Text(event.receivedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }
}

@MainActor
final class NotificationsViewModel: ObservableObject {
    @Published private(set) var history: [NotificationEvent] = []
    @Published var meetingMode: Bool = false
    @Published var signalOnly: Bool = false
    @Published var suppressionMinutes: Int = 0
    @Published var ducking: DuckingMode = .mix
    @Published private(set) var persistStatus: String?

    private let client: NexusShared.NexusClient = NexusShared.NexusClient()
    private var sseTask: Task<Void, Never>?

    private enum Keys {
        static let meetingMode      = "nx.notifications.meetingMode"
        static let signalOnly       = "nx.notifications.signalOnly"
        static let suppressionMin   = "nx.notifications.suppressionMinutes"
        static let ducking          = "elevenlabs.ducking"
    }

    init() {
        let defaults = UserDefaults.standard
        meetingMode = defaults.bool(forKey: Keys.meetingMode)
        signalOnly = defaults.bool(forKey: Keys.signalOnly)
        suppressionMinutes = max(0, defaults.integer(forKey: Keys.suppressionMin))
        if let raw = defaults.string(forKey: Keys.ducking),
           let mode = DuckingMode(rawValue: raw) {
            ducking = mode
        }
    }

    func start() async {
        sseTask?.cancel()
        sseTask = Task { [weak self] in
            guard let self else { return }
            var backoff: UInt64 = 1_000_000_000
            while !Task.isCancelled {
                do {
                    try await self.client.consumeNotifications { [weak self] ev in
                        await self?.prepend(ev)
                    }
                    backoff = 1_000_000_000
                } catch {
                    if Task.isCancelled { return }
                    try? await Task.sleep(nanoseconds: backoff)
                    backoff = min(30_000_000_000, backoff * 2)
                }
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

    func persist() {
        let defaults = UserDefaults.standard
        defaults.set(meetingMode, forKey: Keys.meetingMode)
        defaults.set(signalOnly, forKey: Keys.signalOnly)
        defaults.set(suppressionMinutes, forKey: Keys.suppressionMin)
        defaults.set(ducking.rawValue, forKey: Keys.ducking)
        // Also mirror to the agent so server-side suppression honors the
        // dashboard's intent. Best-effort — agent failure is non-fatal.
        Task { [meetingMode, signalOnly, suppressionMinutes] in
            await client.patchNotificationSettings([
                "meetingMode": meetingMode,
                "signalOnly": signalOnly,
                "suppressionMinutes": suppressionMinutes,
            ])
        }
        persistStatus = "Saved"
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            persistStatus = nil
        }
    }
}
