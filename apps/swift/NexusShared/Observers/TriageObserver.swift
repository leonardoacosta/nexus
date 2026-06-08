// TriageObserver — @MainActor ObservableObject backing the six archetype pages
// (comms / calendar / finance / health / sessions / detail). Clones the
// SourceIndexObserver lifecycle (own a polling task, republish via @Published)
// but for the mx aggregator's unified `TriageItem` feed.
//
// Spec: mx-rkir [nx-ui] — the archetype pages bind to a TriageObserver and read
// `items` (and the per-kind selectors below).
//
// The backing `GET /triage` endpoint is UNSHIPPED. While it returns empty (or a
// transport error), the observer EXPOSES `TriageItem.sampleData` so the views
// render the approved wireframe content, and flips `isSampleData = true` so the
// views can surface a "Sample data" caption — the live state is never silently
// faked. A non-empty live result clears the flag.

import Foundation
import Combine

@MainActor
public final class TriageObserver: ObservableObject {
    /// Coarse load phase so the view can branch loading / loaded without
    /// threading a separate `isLoading` flag. A transport error does NOT
    /// surface as `.error` — it folds into the sample fallback (loaded), since
    /// the endpoint is unshipped and an error is the expected steady state.
    public enum Phase: Equatable, Sendable {
        case loading
        case loaded
    }

    /// The current feed — live items when the endpoint serves them, otherwise
    /// `TriageItem.sampleData`. Check `isSampleData` to caption appropriately.
    @Published public private(set) var items: [TriageItem] = []
    @Published public private(set) var phase: Phase = .loading
    /// True when `items` is the bundled sample fallback (endpoint empty/errored)
    /// rather than live aggregator data. Views surface a "Sample data" caption.
    @Published public private(set) var isSampleData: Bool = true

    public let client: NexusClient

    /// Optional server-side filters (a per-archetype page sets these so the
    /// feed only carries its family — e.g. `kind = "FINANCE_TXN"`).
    private let source: String?
    private let kind: String?

    private var pollTask: Task<Void, Never>?
    private let pollInterval: UInt64

    /// `nonisolated` so SwiftUI `View.init` (not main-actor-isolated) can
    /// default-construct an observer in a `@StateObject` wrapper. Mirrors
    /// SourceIndexObserver / SessionObserver. All `@Published` mutation funnels
    /// through the `@MainActor` methods below.
    nonisolated public init(
        client: NexusClient = NexusClient(),
        source: String? = nil,
        kind: String? = nil,
        pollSeconds: UInt64 = 30
    ) {
        self.client = client
        self.source = source
        self.kind = kind
        self.pollInterval = pollSeconds * 1_000_000_000
    }

    // MARK: - Lifecycle

    public func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in await self?.runPolling() }
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func runPolling() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: pollInterval)
        }
    }

    /// One-shot refresh. A non-empty live result wins; an empty result OR a
    /// transport error both fall back to `TriageItem.sampleData` with
    /// `isSampleData = true` (the endpoint is unshipped, so this is the normal
    /// path until it lands).
    public func refresh() async {
        let live: [TriageItem]
        do {
            live = try await client.fetchTriage(source: source, kind: kind)
        } catch {
            // Endpoint unshipped / unreachable -> sample fallback, not an error.
            self.applySampleFallback()
            return
        }
        if live.isEmpty {
            self.applySampleFallback()
        } else {
            self.items = live
            self.isSampleData = false
            self.phase = .loaded
        }
    }

    private func applySampleFallback() {
        self.items = TriageItem.sampleData
        self.isSampleData = true
        self.phase = .loaded
    }

    // MARK: - Per-archetype selectors

    /// Comms families (email / chat / ticket / work_item / code_review).
    public var comms: [TriageItem] {
        items.filter {
            switch $0.kind {
            case .email, .chatMessage, .ticket, .workItem, .codeReview: return true
            default: return false
            }
        }
    }
    public var calendar: [TriageItem] { items.filter { $0.kind == .calendarEvent } }
    public var finance: [TriageItem]  { items.filter { $0.kind == .financeTxn } }
    public var health: [TriageItem]   { items.filter { $0.kind == .healthMetric } }
    public var sessions: [TriageItem] { items.filter { $0.kind == .codeSession } }

    /// Cross-source "ball in my court" items — the Radar/Needs-you hero count.
    public var mine: [TriageItem] { items.filter { $0.ballInCourt == .mine } }

    #if DEBUG
    /// Preview / test seam — set the feed + phase without hitting the network.
    public func setItemsForPreview(_ value: [TriageItem], isSample: Bool = false) {
        self.items = value
        self.isSampleData = isSample
        self.phase = .loaded
    }
    #endif
}
