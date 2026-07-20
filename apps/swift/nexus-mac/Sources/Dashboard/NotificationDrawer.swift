// NotificationDrawer — the ambient notification + failure history (design § 05).
//
// Spec: openspec/changes/refocus-board-shell (task 3.3)
//
// Slides over the board's right edge (summoned by the titlebar bell / ⌘H),
// never a tab. Re-homes what the deleted NotificationsView did — live
// history (via the retained `NotificationsViewModel`), per-row replay
// (`NotificationHistoryRow`), meeting-mode + drop-non-critical toggles — and
// ABSORBS Failures: script errors surface as red FAIL entries interleaved
// with the notification history (design § 03 — "a failures tab is a graveyard
// nobody checks").

import SwiftUI
import NexusShared

struct NotificationDrawer: View {
    var onClose: () -> Void

    @StateObject private var model = NotificationsViewModel()
    @State private var failures: [ScriptError] = []
    @AppStorage("nx.tts.enabled") private var ttsEnabled = true

    private let client = NexusShared.NexusAggregateClient()

    /// Merged, newest-first stream of notification + failure entries.
    private var entries: [DrawerEntry] {
        var out: [DrawerEntry] = model.history.map { .notification($0) }
        out += failures.map { .failure($0) }
        return out.sorted { $0.time > $1.time }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            toggles
            Divider().overlay(Color.nx.hairline)
            list
            Divider().overlay(Color.nx.hairline)
            foot
        }
        .background(Color.nx.substrate2)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.nx.hairlineStrong).frame(width: 1)
        }
        .task {
            await model.start()
            failures = await client.fetchScriptErrors(limit: 20, days: 7)
        }
        .onDisappear { model.stop() }
        .accessibilityIdentifier("notification-drawer")
    }

    // MARK: - Chrome

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "bell.fill").foregroundStyle(Color.nx.ink2)
            Text("Notifications")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.nx.ink)
            if !failures.isEmpty {
                Text("\(failures.count) fail")
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(Color.nx.critical)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark").foregroundStyle(Color.nx.ink3)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("notification-drawer-close")
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .background(Color.nx.substrate3)
    }

    private var toggles: some View {
        HStack(spacing: 18) {
            DrawerToggle(label: "TTS", on: $ttsEnabled)
            DrawerToggle(
                label: "Meeting mode",
                on: Binding(
                    get: { model.meetingMode },
                    set: { model.meetingMode = $0; model.persist() }
                )
            )
            DrawerToggle(
                label: "Drop non-critical",
                on: Binding(
                    get: { model.signalOnly },
                    set: { model.signalOnly = $0; model.persist() }
                )
            )
            Spacer()
            if let status = model.persistStatus {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(status == "Save failed" ? Color.nx.critical : .green)
                    .accessibilityIdentifier("notification-drawer-persist-status")
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
    }

    private var list: some View {
        Group {
            if entries.isEmpty {
                ContentUnavailableView(
                    "Nothing yet",
                    systemImage: "bell.slash",
                    description: Text("Notification + failure history appears here.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(entries) { entry in
                            switch entry {
                            case .notification(let ev):
                                NotificationHistoryRow(event: ev, player: model.audioPlayer)
                                Divider().overlay(Color.nx.hairline).padding(.leading, 14)
                            case .failure(let err):
                                FailureRow(error: err)
                                Divider().overlay(Color.nx.hairline).padding(.leading, 14)
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var foot: some View {
        HStack {
            Text("ElevenLabs · voice: leo-default")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color.nx.ink4)
            Spacer()
            Button("clear history") { model.clearHistory() }
                .buttonStyle(.plain)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color.nx.ink3)
                .disabled(model.history.isEmpty)
        }
        .padding(.horizontal, 18).padding(.vertical, 11)
    }
}

/// A FAIL entry in the drawer — a script error absorbed from the deleted
/// Failures tab (design § 05).
private struct FailureRow: View {
    let error: ScriptError

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(Color.nx.critical)
                .frame(width: 6, height: 6)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(error.script)
                        .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.nx.ink)
                    if let project = error.project, !project.isEmpty {
                        Text(project)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Color.nx.ink4)
                    }
                }
                Text(error.message)
                    .font(.caption2)
                    .foregroundStyle(Color.nx.ink3)
                    .lineLimit(2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                Text(error.capturedAt, style: .relative)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Color.nx.ink4)
                Text("FAIL")
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(Color.nx.critical)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.nx.criticalDim))
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 8)
    }
}

private struct DrawerToggle: View {
    let label: String
    @Binding var on: Bool
    var body: some View {
        Button {
            on.toggle()
        } label: {
            HStack(spacing: 8) {
                Capsule()
                    .fill(on ? Color.nx.phosphor.opacity(0.18) : Color.nx.substrate3)
                    .frame(width: 30, height: 17)
                    .overlay(alignment: on ? .trailing : .leading) {
                        Circle()
                            .fill(on ? Color.nx.phosphor : Color.nx.ink3)
                            .frame(width: 11, height: 11)
                            .padding(2)
                    }
                    .overlay(Capsule().stroke(on ? Color.nx.phosphorDim : Color.nx.hairlineStrong))
                Text(label)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(Color.nx.ink2)
            }
        }
        .buttonStyle(.plain)
    }
}

/// A merged drawer entry — a notification or an absorbed failure.
private enum DrawerEntry: Identifiable {
    case notification(NotificationEvent)
    case failure(ScriptError)

    var id: String {
        switch self {
        case .notification(let ev): return "n:\(ev.id.uuidString)"
        case .failure(let err):     return "f:\(err.id)"
        }
    }

    var time: Date {
        switch self {
        case .notification(let ev): return ev.receivedAt
        case .failure(let err):     return err.capturedAt
        }
    }
}
