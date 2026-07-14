// BoardPrefetchTests — the board's visible-row prefetch selection logic:
// exactly the first 20 visible `.proposal` rows' `proposal.md`, never orphans,
// never design/tasks, and skipping rows already fresh in the cache.
//
// Spec: openspec/changes/add-board-detail-content-cache (E2E batch, nx-lftx2)
//
// Placement mirrors SpecContentCacheTests: host-bundled nexus-mac-Tests,
// `@testable import nexus` (BoardViewModel + Board* types live in the app
// target), fixtures from NexusShared. No network — `prefetchKeys` is pure and
// the skip-fresh path is driven through a real `SpecContentCache` with injected
// closures.

import XCTest
@testable import nexus
import NexusShared

private actor PrefetchRecorder {
    private(set) var keys: [SpecContentCache.CacheKey] = []
    func record(_ key: SpecContentCache.CacheKey) { keys.append(key) }
}

final class BoardPrefetchTests: XCTestCase {

    // MARK: - Fixtures

    private func proposalItem(_ project: String, _ slug: String) -> BoardWorkItem {
        let rollup = BeadRollup(tasks: BeadTaskCounts(total: 0, closed: 0, ready: 0, blocked: 0))
        let prop = RoadmapProposal(slug: slug, rollup: rollup, specStatus: "draft")
        return .proposal(BoardProposal(project: project, capabilityName: "cap", proposal: prop))
    }

    private func orphanItem(_ id: String, project: String) -> BoardWorkItem {
        .orphan(BoardOrphan(bead: UnlinkedBead(
            id: id, title: "orphan \(id)", status: "open", priority: 2, type: "task", project: project
        )))
    }

    // MARK: - Selection: first 20 proposals, in order, proposal.md only

    func test_prefetchKeys_firstTwentyProposals_neverOrphansOrOtherTabs() {
        // 25 proposals interleaved with orphans (orphans must be skipped).
        var items: [BoardWorkItem] = []
        for i in 0..<25 {
            items.append(proposalItem("nx", "spec-\(i)"))
            if i % 4 == 0 { items.append(orphanItem("o-\(i)", project: "nx")) }
        }

        let keys = BoardViewModel.prefetchKeys(from: items)

        // Exactly the first 20 proposal slugs, in list order.
        XCTAssertEqual(keys.count, 20)
        XCTAssertEqual(
            keys,
            (0..<20).map { SpecContentCache.CacheKey(project: "nx", slug: "spec-\($0)", file: "proposal") }
        )
        // Never any tab but proposal.
        XCTAssertTrue(keys.allSatisfy { $0.file == "proposal" })
        XCTAssertFalse(keys.contains { $0.file == "design" || $0.file == "tasks" })
    }

    func test_prefetchKeys_orphanOnlyList_yieldsNothing() {
        let items = (0..<5).map { orphanItem("o-\($0)", project: "nx") }
        XCTAssertTrue(BoardViewModel.prefetchKeys(from: items).isEmpty)
    }

    func test_prefetchKeys_underLimit_returnsAllProposals() {
        let items = (0..<3).map { proposalItem("nx", "spec-\($0)") }
        XCTAssertEqual(BoardViewModel.prefetchKeys(from: items).count, 3)
    }

    // MARK: - Skip rows already fresh in the cache

    func test_prefetch_skipsRowsAlreadyFreshInCache() async {
        let items = (0..<5).map { proposalItem("nx", "spec-\($0)") }
        let keys = BoardViewModel.prefetchKeys(from: items)
        let cache = SpecContentCache()

        // Pre-warm one row so it is `.fresh` before the prefetch sweep.
        _ = await cache.prefetch(key: keys[2], using: { _ in "already-cached" })

        // Sweep all keys through the cache with a recording fetcher.
        let recorder = PrefetchRecorder()
        for k in keys {
            _ = await cache.prefetch(key: k, using: { kk in
                await recorder.record(kk)
                return "fetched"
            })
        }

        let requested = await recorder.keys
        XCTAssertFalse(requested.contains(keys[2]), "an already-fresh row must be skipped")
        XCTAssertEqual(requested.count, keys.count - 1, "every other row must be fetched exactly once")
    }
}
