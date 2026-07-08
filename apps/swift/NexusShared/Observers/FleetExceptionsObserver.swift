// FleetExceptionsObserver — @MainActor ObservableObject backing the menubar
// "fleet exceptions" section. Clones the TriageObserver / SourceIndexObserver
// lifecycle (own a polling task, republish via @Published) but for the agent's
// `GET /exceptions` feed.
//
// Spec: openspec/changes/add-fleet-exceptions-feed (task 2.1)
//
// Silent-when-clean: a clean fleet returns `[]`, which the section renders as
// nothing at all (no empty-state placeholder). A transport error LEAVES the
// last-known feed untouched so a transient blip never flashes the section away.

import Foundation
import Combine

@MainActor
public final class FleetExceptionsObserver: ObservableObject {
    /// The current feed — one row per (repo, class). Empty means "clean fleet"
    /// (or not yet loaded); the section renders nothing in that case.
    @Published public private(set) var exceptions: [FleetException] = []

    public let client: NexusClient

    private var pollTask: Task<Void, Never>?
    private let pollInterval: UInt64

    /// `nonisolated` so a SwiftUI `View.init` (not main-actor-isolated) can
    /// default-construct the observer in a `@StateObject` wrapper. Mirrors
    /// TriageObserver / SourceIndexObserver. All `@Published` mutation funnels
    /// through the `@MainActor` methods below.
    nonisolated public init(
        client: NexusClient = NexusClient(),
        pollSeconds: UInt64 = 30
    ) {
        self.client = client
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

    /// One-shot refresh. A successful fetch replaces the feed (an empty array
    /// clears the section — silent-when-clean). A transport error keeps the
    /// last-known-good feed so the section doesn't flicker on a blip.
    public func refresh() async {
        do {
            self.exceptions = try await client.fetchFleetExceptions()
        } catch {
            // Keep last-known-good; the section stays as it was.
        }
    }

    #if DEBUG
    /// Preview / test seam — set the feed without hitting the network.
    public func setExceptionsForPreview(_ value: [FleetException]) {
        self.exceptions = value
    }
    #endif
}
