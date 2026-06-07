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

/// Sort mode for the notification history list (notifications-overhaul,
/// task 3.5). Persisted across launches via `@AppStorage`.
enum NotificationSortMode: String, CaseIterable, Identifiable {
    case time    // newest -> oldest
    case project // alphabetical, nil-project last
    case session // alphabetical by channel as a session proxy

    var id: String { rawValue }

    var label: String {
        switch self {
        case .time:    return "Time"
        case .project: return "Project"
        case .session: return "Session"
        }
    }
}

struct NotificationsView: View {
    @StateObject private var model = NotificationsViewModel()
    @AppStorage("notifications.sort") private var sortRaw: String = NotificationSortMode.time.rawValue

    /// Per-group collapse state for the grouped accordion (nx-2g2j4). A group
    /// key present in this set is COLLAPSED; absence means expanded. Default-open
    /// semantics: a freshly-seen group is expanded until the user collapses it.
    /// Keyed off the stable `entry.group` string so state survives re-renders as
    /// the history list mutates.
    @State private var collapsedGroups: Set<String> = []

    private var sortMode: NotificationSortMode {
        NotificationSortMode(rawValue: sortRaw) ?? .time
    }

    private func setSortMode(_ mode: NotificationSortMode) {
        sortRaw = mode.rawValue
    }

    /// Real per-group expand/collapse binding for the accordion (nx-2g2j4).
    /// Default-open: a group is expanded unless its key is in `collapsedGroups`.
    /// Toggling inserts/removes the key (animated), so the chevron actually
    /// collapses and expands instead of being frozen by `.constant(true)`.
    private func expansionBinding(for group: String) -> Binding<Bool> {
        Binding(
            get: { !collapsedGroups.contains(group) },
            set: { expanded in
                withAnimation(.easeInOut(duration: 0.18)) {
                    if expanded {
                        collapsedGroups.remove(group)
                    } else {
                        collapsedGroups.insert(group)
                    }
                }
            }
        )
    }

    var body: some View {
        // dashboard-ui-pass-v1 (task 2.4): replaced HSplitView with a
        // VStack so the history body gets the full window width. Settings
        // collapsed into a compact bottom toolbar — daily-use controls
        // remain one click away without consuming horizontal real-estate.
        VStack(spacing: 0) {
            historyPane
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            settingsToolbar
        }
        .task {
            await model.start()
        }
        .onDisappear {
            model.stop()
        }
    }

    /// Apply the persisted sort mode to the raw newest-first history.
    /// Pulled out into a static helper so the test target can pin the
    /// ordering rules without instantiating SwiftUI views.
    static func sorted(
        _ events: [NotificationEvent],
        mode: NotificationSortMode
    ) -> [NotificationEvent] {
        switch mode {
        case .time:
            return events.sorted { $0.receivedAt > $1.receivedAt }
        case .project:
            return events.sorted { lhs, rhs in
                // Nil/empty project sorts LAST regardless of receivedAt.
                let lp = lhs.project ?? ""
                let rp = rhs.project ?? ""
                if lp.isEmpty && rp.isEmpty {
                    return lhs.receivedAt > rhs.receivedAt
                }
                if lp.isEmpty { return false }
                if rp.isEmpty { return true }
                if lp == rp { return lhs.receivedAt > rhs.receivedAt }
                return lp < rp
            }
        case .session:
            return events.sorted { lhs, rhs in
                // Channel acts as a session proxy until a real session id
                // ships on the wire (NotificationEvent has no sessionId).
                let ls = lhs.channel ?? ""
                let rs = rhs.channel ?? ""
                if ls.isEmpty && rs.isEmpty {
                    return lhs.receivedAt > rhs.receivedAt
                }
                if ls.isEmpty { return false }
                if rs.isEmpty { return true }
                if ls == rs { return lhs.receivedAt > rhs.receivedAt }
                return ls < rs
            }
        }
    }

    /// Group rows for the disclosure view (task 3.6). "Misc" key holds
    /// rows lacking the group field and is sorted to the end.
    static func grouped(
        _ events: [NotificationEvent],
        mode: NotificationSortMode
    ) -> [(group: String, rows: [NotificationEvent])] {
        let keyFor: (NotificationEvent) -> String = { ev in
            switch mode {
            case .time: return ""
            case .project: return ev.project?.isEmpty == false ? ev.project! : "Misc"
            case .session: return ev.channel?.isEmpty == false ? ev.channel! : "Misc"
            }
        }
        var buckets: [String: [NotificationEvent]] = [:]
        for ev in events {
            buckets[keyFor(ev), default: []].append(ev)
        }
        // Stable key order: alphabetical, "Misc" last.
        return buckets.keys.sorted { lhs, rhs in
            if lhs == "Misc" { return false }
            if rhs == "Misc" { return true }
            return lhs < rhs
        }.map { ($0, buckets[$0] ?? []) }
    }

    private var historyPane: some View {
        let sortedRows = NotificationsView.sorted(model.history, mode: sortMode)
        // nx-2g2j4: Project & Session always group; Time is not groupable.
        // The standalone group toggle was removed — grouping is now implied by
        // the sort mode.
        let groupingActive = sortMode != .time

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("HISTORY")
                    .font(.system(.caption, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(.secondary)

                ElevenLabsStatusChip(state: model.elevenLabsKeyState)
                    .onTapGesture {
                        model.toggleElevenLabsPopover()
                    }

                Spacer()

                // notifications-overhaul (task 3.5): sort picker.
                Picker("Sort", selection: Binding(
                    get: { sortMode },
                    set: { setSortMode($0) }
                )) {
                    ForEach(NotificationSortMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)

                // nx-2g2j4: the standalone group toggle was removed. Project &
                // Session sort modes always group; Time never does. Grouping is
                // implied by the sort picker above.

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
            } else if groupingActive {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let groups = NotificationsView.grouped(sortedRows, mode: sortMode)
                        ForEach(groups, id: \.group) { entry in
                            DisclosureGroup(isExpanded: expansionBinding(for: entry.group)) {
                                ForEach(entry.rows) { ev in
                                    NotificationHistoryRow(event: ev, player: model.audioPlayer)
                                    Divider().padding(.leading, 14)
                                }
                            } label: {
                                HStack {
                                    Text(entry.group)
                                        .font(.system(.caption, design: .monospaced))
                                        .tracking(1)
                                        .foregroundStyle(.secondary)
                                    Text("\(entry.rows.count)")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 4)
                        }
                    }
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(sortedRows) { ev in
                            NotificationHistoryRow(event: ev, player: model.audioPlayer)
                            Divider().padding(.leading, 14)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .popover(isPresented: $model.elevenLabsPopover) {
            ElevenLabsStatusPopover(model: model)
        }
    }

    /// Compact bottom toolbar — replaces the previous right-hand settings
    /// pane. Mode picker (Mix / Meet), Signal-only toggle, Suppression
    /// stepper, Ducking menu. Stays bound to the same NotificationsModel
    /// so SettingsView and the agent stay in sync via the existing
    /// `model.persist()` flow.
    private var settingsToolbar: some View {
        HStack(spacing: 14) {
            // Mode picker — Mix is the default ("normal"); Meet is meeting-mode.
            Picker("Mode", selection: $model.meetingMode) {
                Text("Mix").tag(false)
                Text("Meet").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 110)
            .onChange(of: model.meetingMode) { _, _ in model.persist() }
            .help("Meeting mode suppresses all TTS delivery")

            Toggle(isOn: $model.signalOnly) {
                Image(systemName: "waveform.path.ecg")
                Text("Signal only")
                    .font(.caption)
            }
            .toggleStyle(.button)
            .controlSize(.small)
            .onChange(of: model.signalOnly) { _, _ in model.persist() }
            .help("Drop TTS body; banner only")

            HStack(spacing: 4) {
                Image(systemName: "clock")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Stepper(value: $model.suppressionMinutes, in: 0...60, step: 1) {
                    Text("\(model.suppressionMinutes)m")
                        .font(.caption.monospacedDigit())
                        .frame(minWidth: 24)
                }
                .controlSize(.small)
                .labelsHidden()
                .onChange(of: model.suppressionMinutes) { _, _ in model.persist() }
            }
            .help("Coalesce notifications within this minute window")

            Menu {
                Picker("Ducking", selection: $model.ducking) {
                    Text("Mix").tag(DuckingMode.mix)
                    Text("Duck").tag(DuckingMode.duck)
                    Text("Quiet").tag(DuckingMode.pause)
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "speaker.wave.2")
                        .font(.caption2)
                    Text(duckingLabel(model.ducking))
                        .font(.caption)
                }
            }
            .menuStyle(.borderlessButton)
            .controlSize(.small)
            .fixedSize()
            .onChange(of: model.ducking) { _, _ in model.persist() }
            .help("How audio interacts with other system audio")

            Spacer()

            if let status = model.persistStatus {
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(.green)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.regularMaterial)
    }

    private func duckingLabel(_ mode: DuckingMode) -> String {
        switch mode {
        case .mix:   return "Mix"
        case .duck:  return "Duck"
        case .pause: return "Quiet"
        }
    }
}

private struct NotificationHistoryRow: View {
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
            // notifications-overhaul (task 3.7 + 3.8): replay button when
            // the agent has a cached MP3. Hidden entirely otherwise so
            // older clients keep the existing row layout.
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
    @Published var meetingMode: Bool = false
    @Published var signalOnly: Bool = false
    @Published var suppressionMinutes: Int = 0
    @Published var ducking: DuckingMode = .mix
    @Published private(set) var persistStatus: String?
    @Published var elevenLabsKeyState: ElevenLabsKeyState = .unknown
    @Published var elevenLabsPopover: Bool = false

    /// Player handle threaded into row replay buttons. Defaults to the
    /// shared AudioPlayer; the test target can inject a stub via
    /// `NotificationsView(model:)` once that initializer ships.
    let audioPlayer: MP3PlayerProtocol? = AudioPlayer.shared

    let client = NexusShared.NexusAggregateClient()
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
            // subscribing to live SSE. Without this the HISTORY sidebar shows
            // "No notifications yet" until the next NotificationFired arrives
            // even though the agent has persisted rows on disk.
            let historical = await self.client.fetchNotifications()
            FileHandle.standardError.write(Data(
                "[NotificationsView] fetchNotifications backfill: \(historical.count) rows\n".utf8
            ))
            if !historical.isEmpty {
                await self.prependBatch(historical)
            }
            // Aggregate owns per-agent retry; this returns on cancel only.
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

    /// nx-9mt43: prepend a batch of historical rows on mount. Aggregate
    /// already returns newest-first; replace the empty list to preserve
    /// that order, then cap at 100.
    private func prependBatch(_ events: [NotificationEvent]) {
        if history.isEmpty {
            history = Array(events.prefix(100))
            return
        }
        // Live frames may have already landed during the fetch; merge by id.
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
