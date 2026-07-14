// SpecContentCache — in-memory, stale-while-revalidate cache for the board
// detail rail's spec markdown (proposal / design / tasks).
//
// Spec: openspec/changes/add-board-detail-content-cache (API batch)
//
// Why it exists
// ─────────────
// `BoardDetailModel.loadContent()` used to call `NexusAggregateClient
// .fetchSpecContent` fresh on every row click and every proposal/design/tasks
// tab switch — a cold network round-trip with a blocking spinner each time.
// This cache renders previously-fetched content instantly while a background
// refresh runs, and lets the board eagerly warm the default tab of visible
// proposal rows.
//
// Design
// ──────
//   - `actor`-isolated so rapid row-clicking (concurrent `fetch` calls) can
//     never race the entry map (spec Risk: "Actor/concurrency bugs under rapid
//     row-clicking").
//   - Keyed by (project, slug, file). Session-scoped, in-memory only — no
//     persistence, no TTL, no eviction. Always revalidates on selection.
//   - `fetch(key:using:)` streams state transitions
//     (`.cachedOnly` → `.fetchInFlight` → `.fresh`) so the detail rail can
//     render cached content immediately and update in place when the refetch
//     resolves. `prefetch(key:using:)` is the fire-and-forget warm path used by
//     the board's visible-row prefetch trigger.
//
// The companion `add-board-detail-live-updates` change builds SSE live-update
// wiring on top of this same cache/state model — keep `Snapshot` / `CacheState`
// as the single source of truth for "what is the detail rail showing and how
// fresh is it".

import Foundation

/// In-memory stale-while-revalidate cache for spec markdown content.
actor SpecContentCache {
    /// App-wide shared instance. The cache is session-scoped and shared between
    /// the board's prefetch trigger (warms visible rows) and the detail rail
    /// (reads + revalidates the selected row) so a prefetch actually primes the
    /// content the rail later renders. Tests construct their own instances.
    static let shared = SpecContentCache()

    /// Cache identity for one spec document: which project, which proposal
    /// slug, which file (`proposal` / `design` / `tasks`).
    struct CacheKey: Hashable, Sendable {
        let project: String
        let slug: String
        let file: String

        init(project: String, slug: String, file: String) {
            self.project = project
            self.slug = slug
            self.file = file
        }
    }

    /// Freshness of the currently-held content for a key.
    enum CacheState: Equatable, Sendable {
        /// Rendering stale/prefetched content; no live fetch has resolved for
        /// the current selection yet.
        case cachedOnly
        /// A request is currently running.
        case fetchInFlight
        /// The held content reflects the most recent successful fetch, at the
        /// given timestamp.
        case fresh(Date)
    }

    /// A point-in-time view of a cache entry: the content (may be nil when a
    /// proposal has no such file) plus its freshness state.
    struct Snapshot: Equatable, Sendable {
        var content: String?
        var state: CacheState

        init(content: String?, state: CacheState) {
            self.content = content
            self.state = state
        }
    }

    /// Async fetcher shape matching `NexusAggregateClient.fetchSpecContent`
    /// (returns nil when every reachable agent 404s / fails, or when the file
    /// genuinely does not exist).
    typealias Fetcher = @Sendable (CacheKey) async -> String?

    private var entries: [CacheKey: Snapshot] = [:]
    private var inFlight: Set<CacheKey> = []

    init() {}

    // MARK: - Detail-rail read (stale-while-revalidate)

    /// Returns a stream of snapshots for `key`: emits the cached content
    /// immediately (as `.cachedOnly`) if present, always kicks a background
    /// revalidation (`.fetchInFlight`), and emits the resolved content as
    /// `.fresh(Date())` when the fetch completes, then finishes.
    ///
    /// Consumers drive this with `for await snap in cache.fetch(...)` and
    /// publish `snap` to the view; SwiftUI's `.task(id:)` cancellation tears the
    /// stream down (and cancels the in-flight fetch) when the selection changes.
    nonisolated func fetch(
        key: CacheKey,
        using fetcher: @escaping Fetcher
    ) -> AsyncStream<Snapshot> {
        AsyncStream { continuation in
            let task = Task {
                await self.runFetch(key: key, fetcher: fetcher, continuation: continuation)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func runFetch(
        key: CacheKey,
        fetcher: @escaping Fetcher,
        continuation: AsyncStream<Snapshot>.Continuation
    ) async {
        // 1. Render any cached content immediately as stale (.cachedOnly) — a
        //    prefetch may have stored it as .fresh, but no live fetch has
        //    resolved for THIS selection yet.
        let cachedContent = entries[key]?.content
        if let cachedContent {
            let stale = Snapshot(content: cachedContent, state: .cachedOnly)
            entries[key] = stale
            continuation.yield(stale)
        }

        // 2. Mark in-flight (keep showing cached content underneath, if any).
        let pending = Snapshot(content: cachedContent, state: .fetchInFlight)
        entries[key] = pending
        inFlight.insert(key)
        continuation.yield(pending)

        // 3. Revalidate.
        let body = await fetcher(key)
        inFlight.remove(key)

        if Task.isCancelled {
            continuation.finish()
            return
        }

        // 4. Publish the resolved content as fresh. A nil body is a valid
        //    "no such file" answer (mirrors the pre-cache behaviour, which set
        //    content = nil and rendered the "No X.md" empty state).
        let fresh = Snapshot(content: body, state: .fresh(Date()))
        entries[key] = fresh
        continuation.yield(fresh)
        continuation.finish()
    }

    // MARK: - Prefetch (background warm)

    /// Warms `key` if it is not already fresh or in-flight, then stores the
    /// result. Returns true when a fetch was actually run (used by tests to
    /// assert exactly which rows were requested), false when skipped. Failures
    /// / nil bodies silently no-op — the entry is left uncached so a later
    /// selection revalidates cleanly, and no retry-storm is triggered.
    ///
    /// This is `async` and does the full fetch-and-store inline; the
    /// fire-and-forget, UI-non-blocking property comes from the caller wrapping
    /// a batch of these in a background `Task` (see `BoardViewModel
    /// .prefetchVisible`).
    @discardableResult
    func prefetch(key: CacheKey, using fetcher: @escaping Fetcher) async -> Bool {
        if inFlight.contains(key) { return false }
        if case .fresh = entries[key]?.state { return false }

        inFlight.insert(key)
        entries[key] = Snapshot(content: entries[key]?.content, state: .fetchInFlight)

        let body = await fetcher(key)
        inFlight.remove(key)

        if let body {
            entries[key] = Snapshot(content: body, state: .fresh(Date()))
        } else if entries[key]?.state == .fetchInFlight {
            // Failure or no content — drop the in-flight marker so a later
            // selection revalidates from scratch rather than skipping a "fresh"
            // stale-empty entry.
            entries[key] = nil
        }
        return true
    }

    // MARK: - Read

    /// Current snapshot for `key`, or nil if the key was never touched.
    /// Exposed for tests and for the detail rail's synchronous state reads.
    func snapshot(for key: CacheKey) -> Snapshot? {
        entries[key]
    }
}
