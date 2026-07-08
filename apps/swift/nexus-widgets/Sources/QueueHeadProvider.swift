// QueueHeadProvider — the TimelineProvider shell for the queue-head widget
// (openspec/changes/add-queue-head-widget, task 1.2).
//
// Thin wiring only: the three-state math lives in NexusShared
// (`QueueHeadTimelineCore`), unit-tested by NexusSharedTests. This shell:
//   1. resolves the agent endpoint from the extension's Info.plist NEXUS_ENDPOINT,
//   2. loads the previously rendered state (for retain-on-failure),
//   3. asks the core for the next state, persists it, and
//   4. schedules the next refresh ~15 min out (system-budgeted).

import WidgetKit
import Foundation
import NexusShared

/// The single timeline entry — a resolved `QueueHeadState` at a point in time.
struct QueueHeadEntry: TimelineEntry {
    let date: Date
    let state: QueueHeadState
}

/// Resolve the agent endpoint from the extension's own Info.plist `NEXUS_ENDPOINT`
/// (mirrors nexus-ios `NexusIOSApp.defaultEndpoint`), falling back to homelab.
enum QueueHeadEndpoint {
    static var resolved: NexusEndpoint {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "NEXUS_ENDPOINT") as? String,
           !raw.isEmpty, let url = URL(string: raw) {
            return NexusEndpoint(baseURL: url)
        }
        return NexusEndpoint(baseURL: URL(string: "http://homelab:7400")!)
    }
}

/// Persists the last-good widget state in the extension's own UserDefaults so a
/// later fetch FAILURE can retain it (retain-on-failure). No app group needed —
/// the widget only needs to remember its OWN last render, not share with the app.
struct QueueHeadStore {
    static let shared = QueueHeadStore()

    private let defaults = UserDefaults.standard
    private let kind = "nexus.widget.queueHead.kind"     // "head" | "clear"
    private let action = "nexus.widget.queueHead.action"
    private let title = "nexus.widget.queueHead.title"

    func save(_ state: QueueHeadState) {
        switch state {
        case .head(let a, let t):
            defaults.set("head", forKey: kind)
            defaults.set(a, forKey: action)
            defaults.set(t, forKey: title)
        case .clear:
            defaults.set("clear", forKey: kind)
            defaults.removeObject(forKey: action)
            defaults.removeObject(forKey: title)
        }
    }

    /// nil when nothing was ever persisted (first-ever render).
    func load() -> QueueHeadState? {
        switch defaults.string(forKey: kind) {
        case "head":
            guard let a = defaults.string(forKey: action),
                  let t = defaults.string(forKey: title) else { return nil }
            return .head(action: a, title: t)
        case "clear":
            return .clear
        default:
            return nil
        }
    }
}

struct QueueHeadProvider: TimelineProvider {
    /// ~15 min system-budgeted refresh goal (spec: "a widget is a glance").
    private static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> QueueHeadEntry {
        QueueHeadEntry(date: Date(), state: .clear)
    }

    func getSnapshot(in context: Context, completion: @escaping (QueueHeadEntry) -> Void) {
        // Gallery/snapshot preview — a representative head, never a live fetch.
        completion(QueueHeadEntry(date: Date(), state: .head(action: "delegate", title: "WHS-346 export")))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QueueHeadEntry>) -> Void) {
        Task {
            let source = NexusQueueHeadSource(client: NexusClient(endpoint: QueueHeadEndpoint.resolved))
            let core = QueueHeadTimelineCore(source: source)
            let previous = QueueHeadStore.shared.load()
            let state = await core.resolve(previous: previous)
            QueueHeadStore.shared.save(state)

            let entry = QueueHeadEntry(date: Date(), state: state)
            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}
