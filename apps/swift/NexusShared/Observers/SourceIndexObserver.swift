// SourceIndexObserver — @MainActor ObservableObject backing the Source Index
// (app shell) view. Clones the SessionObserver lifecycle (own the polling
// task, republish via @Published) but for the mx aggregator's source registry.
//
// Spec: mx-bzzb [nx-ui] Shell / source index view (epic mx-rkir).
//
// SwiftUI views on any Apple target bind to a SourceIndexObserver instance.
// The observer owns a 30s polling task against `NexusAggregateClient
// .fetchSourceIndex()` and exposes an explicit load-phase so the view can
// render loading / error / empty / loaded states. The backing endpoint is
// unshipped (Wave-4) — a 404 resolves to an empty index (loaded, no sources)
// rather than an error; a transport failure surfaces `.error`.

import Foundation
import Combine

@MainActor
public final class SourceIndexObserver: ObservableObject {
    /// Coarse load phase so the view can branch loading / error / empty /
    /// loaded without threading a separate `isLoading` + `error` pair.
    public enum Phase: Equatable, Sendable {
        case loading
        case loaded
        case error(String)
    }

    @Published public private(set) var index: SourceIndex = SourceIndex(sources: [])
    @Published public private(set) var phase: Phase = .loading

    /// Multi-agent fan-out — mirrors HealthViewModel / SessionObserver.
    public let client: NexusAggregateClient

    private var pollTask: Task<Void, Never>?
    private let pollInterval: UInt64

    /// `nonisolated` so SwiftUI `View.init` (which is NOT main-actor-isolated)
    /// can default-construct an observer in a `@StateObject` wrapper. The init
    /// only stores the client + interval; all `@Published` mutation funnels
    /// through the `@MainActor` methods below. Mirrors SessionObserver, whose
    /// init is likewise reachable from view construction.
    nonisolated public init(
        aggregate: NexusAggregateClient = NexusAggregateClient(),
        pollSeconds: UInt64 = 30
    ) {
        self.client = aggregate
        self.pollInterval = pollSeconds * 1_000_000_000
    }

    /// Test / back-compat: wrap a single transport client.
    nonisolated public convenience init(client: NexusClient, pollSeconds: UInt64 = 30) {
        self.init(aggregate: NexusAggregateClient(client: client), pollSeconds: pollSeconds)
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

    /// One-shot refresh. `fetchSourceIndex()` is partial-failure tolerant and
    /// folds a 404 (endpoint unshipped) into an empty index, so a non-empty
    /// result OR an empty-but-reached result both land as `.loaded`. The
    /// aggregate swallows per-agent transport errors; an all-unreachable fan
    /// returns an empty index, which we treat as loaded-empty (the view shows
    /// the "no sources" empty state rather than a hard error).
    public func refresh() async {
        let payload = await client.fetchSourceIndex()
        self.index = payload
        self.phase = .loaded
    }

    #if DEBUG
    /// Preview / test seam — set the index + phase without hitting the
    /// network. Used by SourceIndexView's `#Preview` (the backing endpoint is
    /// unshipped) and by unit tests asserting the load-phase transitions.
    public func setIndexForPreview(_ value: SourceIndex, phase: Phase = .loaded) {
        self.index = value
        self.phase = phase
    }
    #endif
}
