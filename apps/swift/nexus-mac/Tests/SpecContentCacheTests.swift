// SpecContentCacheTests — cache read/state-transition behaviour under rapid
// concurrent selections + the board's visible-row prefetch selection logic.
//
// Spec: openspec/changes/add-board-detail-content-cache (E2E batch)
//
// Target placement
// ────────────────
// Lives in nexus-mac-Tests (host-bundled, TEST_HOST = nexus.app per
// project.yml) because `SpecContentCache` + `BoardViewModel` live in the
// nexus-mac app target (product module `nexus`), reached via `@testable import
// nexus`. The pre-push integration gate runs this bundle via the consolidated
// `nexus-mac` scheme.
//
// No network: every fetch is driven by an injected closure, so these assert the
// cache's own state machine + the prefetch selection/skip logic deterministically.

import XCTest
@testable import nexus
import NexusShared

// MARK: - Test doubles

/// A gate the test opens to release a blocked fetcher — lets us assert cached
/// content is delivered *before* the background refetch resolves.
private actor Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false

    func wait() async {
        if opened { return }
        await withCheckedContinuation { c in self.continuation = c }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
    }
}

/// Records which keys a fetcher was actually invoked for (Sendable-safe under
/// concurrency via actor isolation).
private actor KeyRecorder {
    private(set) var keys: [SpecContentCache.CacheKey] = []
    func record(_ key: SpecContentCache.CacheKey) { keys.append(key) }
}

final class SpecContentCacheTests: XCTestCase {

    private func key(_ project: String, _ slug: String, _ file: String = "proposal")
        -> SpecContentCache.CacheKey
    {
        SpecContentCache.CacheKey(project: project, slug: slug, file: file)
    }

    // MARK: - fetch: first selection (cold) → in-flight → fresh

    func test_coldFetch_emitsInFlightThenFresh() async {
        let cache = SpecContentCache()
        let k = key("nx", "add-thing")

        var snaps: [SpecContentCache.Snapshot] = []
        for await snap in cache.fetch(key: k, using: { _ in "BODY-V1" }) {
            snaps.append(snap)
        }

        // Nothing cached → no `.cachedOnly` emit; in-flight (nil content) then
        // fresh with the fetched body.
        XCTAssertEqual(snaps.count, 2)
        XCTAssertEqual(snaps[0].content, nil)
        XCTAssertEqual(snaps[0].state, .fetchInFlight)
        XCTAssertEqual(snaps[1].content, "BODY-V1")
        guard case .fresh = snaps[1].state else {
            return XCTFail("expected final state .fresh, got \(snaps[1].state)")
        }
    }

    // MARK: - fetch: second selection returns cached content immediately

    func test_secondSelection_deliversCachedContentBeforeRefetchResolves() async {
        let cache = SpecContentCache()
        let k = key("nx", "add-thing")

        // Prime: run a fetch to completion so the key is cached fresh ("V1").
        for await _ in cache.fetch(key: k, using: { _ in "V1" }) {}

        // Second selection with a fetcher gated open only after we assert the
        // immediate cached delivery. runFetch yields `.cachedOnly` then
        // `.fetchInFlight` synchronously BEFORE awaiting the fetcher, so manual
        // iteration is deterministic.
        let gate = Gate()
        var iterator = cache.fetch(key: k, using: { _ in
            await gate.wait()
            return "V2"
        }).makeAsyncIterator()

        // 1. Cached content available immediately, marked stale — fetcher still
        //    blocked on the gate.
        let s1 = await iterator.next()
        XCTAssertEqual(s1?.content, "V1", "cached content must render before the refetch resolves")
        XCTAssertEqual(s1?.state, .cachedOnly)

        // 2. In-flight, still showing the cached content underneath.
        let s2 = await iterator.next()
        XCTAssertEqual(s2?.content, "V1")
        XCTAssertEqual(s2?.state, .fetchInFlight)

        // 3. Release the refetch → fresh content replaces in place.
        await gate.open()
        let s3 = await iterator.next()
        XCTAssertEqual(s3?.content, "V2")
        guard case .fresh = s3?.state else {
            return XCTFail("expected .fresh after refetch, got \(String(describing: s3?.state))")
        }

        // Stream finishes.
        let end = await iterator.next()
        XCTAssertNil(end)
    }

    // MARK: - fetch: nil body is a valid "no such file" fresh result

    func test_nilBody_resolvesToFreshNil() async {
        let cache = SpecContentCache()
        let k = key("nx", "no-design", "design")

        var last: SpecContentCache.Snapshot?
        for await snap in cache.fetch(key: k, using: { _ in nil }) { last = snap }

        XCTAssertEqual(last?.content, nil)
        guard case .fresh = last?.state else {
            return XCTFail("nil body should still resolve to .fresh, got \(String(describing: last?.state))")
        }
    }

    // MARK: - actor isolation under rapid concurrent selections

    func test_rapidConcurrentSelections_allResolveFresh_noDataRace() async {
        let cache = SpecContentCache()
        let keys = (0..<50).map { key("nx", "spec-\($0)") }

        // Fire all fetches concurrently — actor isolation must serialise the
        // entry-map mutations without a crash or lost update.
        await withTaskGroup(of: Void.self) { group in
            for k in keys {
                group.addTask {
                    for await _ in cache.fetch(key: k, using: { kk in "body-\(kk.slug)" }) {}
                }
            }
        }

        // Every key must end cached fresh with its own body (no cross-key bleed).
        for k in keys {
            let snap = await cache.snapshot(for: k)
            XCTAssertEqual(snap?.content, "body-\(k.slug)")
            guard case .fresh = snap?.state else {
                return XCTFail("key \(k.slug) not fresh: \(String(describing: snap?.state))")
            }
        }
    }

    func test_rapidRepeatedSameKey_settlesFresh() async {
        let cache = SpecContentCache()
        let k = key("nx", "hot-row")

        await withTaskGroup(of: Void.self) { group in
            for i in 0..<20 {
                group.addTask {
                    for await _ in cache.fetch(key: k, using: { _ in "v\(i % 3)" }) {}
                }
            }
        }
        let snap = await cache.snapshot(for: k)
        guard case .fresh = snap?.state else {
            return XCTFail("hot key did not settle fresh: \(String(describing: snap?.state))")
        }
    }

    // MARK: - prefetch: skips already-fresh + in-flight

    func test_prefetch_skipsAlreadyFreshKey() async {
        let cache = SpecContentCache()
        let k = key("nx", "warm")

        // Warm it once.
        let first = await cache.prefetch(key: k, using: { _ in "warmed" })
        XCTAssertTrue(first, "first prefetch should run")

        // Second prefetch must skip (already fresh) — fetcher never invoked.
        let recorder = KeyRecorder()
        let second = await cache.prefetch(key: k, using: { kk in
            await recorder.record(kk)
            return "again"
        })
        XCTAssertFalse(second, "prefetch of a fresh key must be skipped")
        let recorded = await recorder.keys
        XCTAssertTrue(recorded.isEmpty, "skipped prefetch must not invoke the fetcher")
    }

    func test_prefetch_nilBodyLeavesKeyUncached() async {
        let cache = SpecContentCache()
        let k = key("nx", "unreachable")

        let ran = await cache.prefetch(key: k, using: { _ in nil })
        XCTAssertTrue(ran, "prefetch runs even when the body is nil")
        // Failure must not poison the cache with a fresh-empty entry — a later
        // selection should revalidate from scratch.
        let snap = await cache.snapshot(for: k)
        XCTAssertNil(snap, "nil-body prefetch must leave the key uncached")
    }
}
