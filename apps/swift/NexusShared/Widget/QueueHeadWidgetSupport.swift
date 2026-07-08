// QueueHeadWidgetSupport — the WidgetKit-free core of the iOS queue-head widget
// (openspec/changes/add-queue-head-widget, tasks 1.2 + 1.4).
//
// The widget EXTENSION (apps/swift/nexus-widgets) is an iOS target that cannot be
// `@testable import`ed by the macOS NexusSharedTests bundle. So the testable
// timeline LOGIC lives HERE in NexusShared: a pure resolver (`QueueHeadTimelineCore`)
// over an injectable fetch protocol (`QueueHeadFetching`). The extension's
// `TimelineProvider` is a thin shell that persists the previous state and calls
// `resolve(previous:)`; the three-state math (head / clear / retain-on-failure) is
// exercised by NexusSharedTests with a stubbed source.
//
// Anti-bias invariant (spec ## What Changes): the state carries ONLY the verdict
// action + the item title. No counts, no badges, no backlog numbers — ever.

import Foundation

// MARK: - Resolved widget state

/// What the widget renders. Exactly two shapes: an actionable head (verdict action
/// + item title) or a "clear" queue. Deliberately carries NO count / badge / list
/// data — the surface shows the one next thing or nothing.
public enum QueueHeadState: Equatable, Sendable {
    /// The single next action: the verdict's action verb + the item's title.
    case head(action: String, title: String)
    /// Empty queue — nothing to decide.
    case clear

    /// Build a head state from a queue item. The action is the LLM verdict's
    /// action verb (lowercased for a stable label); a verdict-less item falls back
    /// to a neutral "review". The title is passed through untruncated — the views
    /// truncate at render time (SwiftUI `lineLimit`/`truncationMode`).
    public static func head(from item: TriageItem) -> QueueHeadState {
        let raw = item.verdict?.action
        let action = (raw?.isEmpty == false ? raw! : "review").lowercased()
        return .head(action: action, title: item.title)
    }
}

// MARK: - Fetch outcome + source protocol

/// The tri-state result of a queue-head fetch. Crucially DISTINCT from the
/// fail-soft `fetchDecideQueue` (which collapses failure and empty to `[]`):
/// the widget must tell an empty queue (render "clear") apart from a fetch
/// failure (retain the last good entry).
public enum QueueHeadFetchOutcome: Sendable, Equatable {
    /// A verdict-bearing head item was returned.
    case item(TriageItem)
    /// The fetch succeeded but the queue is empty.
    case empty
    /// The fetch failed (transport / non-2xx / decode). Retain last good entry.
    case failed
}

/// Injectable seam so the timeline logic can be unit-tested with a stub in place
/// of the live `NexusClient` (NexusSharedTests can't reach the iOS extension).
public protocol QueueHeadFetching: Sendable {
    func fetchQueueHead() async -> QueueHeadFetchOutcome
}

/// Live source: wraps a `NexusClient` and reads `GET /queue?limit=1`, mapping the
/// result onto the tri-state outcome (see `NexusClient.fetchQueueHeadOutcome`).
public struct NexusQueueHeadSource: QueueHeadFetching {
    private let client: NexusClient

    public init(client: NexusClient) {
        self.client = client
    }

    public func fetchQueueHead() async -> QueueHeadFetchOutcome {
        await client.fetchQueueHeadOutcome()
    }
}

// MARK: - Timeline core (pure, testable)

/// The three-state resolver behind the widget timeline. Given the previously
/// rendered state (persisted by the extension for retain-on-failure), produce the
/// next state:
///   • `.item`  -> head(action, title)
///   • `.empty` -> clear                (a real, successful empty queue)
///   • `.failed`-> previous ?? clear    (retain the last good entry; clear only
///                                        when there is no prior entry to keep)
public struct QueueHeadTimelineCore: Sendable {
    private let source: QueueHeadFetching

    public init(source: QueueHeadFetching) {
        self.source = source
    }

    public func resolve(previous: QueueHeadState?) async -> QueueHeadState {
        switch await source.fetchQueueHead() {
        case .item(let item):
            return .head(from: item)
        case .empty:
            return .clear
        case .failed:
            return previous ?? .clear
        }
    }
}
