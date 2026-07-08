// QueueHeadWidgetTests — the three-state timeline math for the iOS queue-head
// widget (openspec/changes/add-queue-head-widget, task 1.4).
//
// The provider LOGIC lives in NexusShared (QueueHeadTimelineCore) precisely so it
// can be unit-tested here with a stubbed source — the iOS widget extension itself
// can't be `@testable import`ed by this macOS bundle. Three required scenarios:
// head entry, clear entry, retained-entry-on-failure (+ the no-prior fallback).

import XCTest
@testable import NexusShared

final class QueueHeadWidgetTests: XCTestCase {

    // MARK: - Stub

    /// A source that returns a fixed outcome, standing in for the live NexusClient.
    private struct StubSource: QueueHeadFetching {
        let outcome: QueueHeadFetchOutcome
        func fetchQueueHead() async -> QueueHeadFetchOutcome { outcome }
    }

    /// A verdict-bearing head item (action "delegate", title "WHS-346 export").
    private func headItem() -> TriageItem {
        TriageItem(
            id: "wi_1", source: "ado", kind: .workItem, title: "WHS-346 export",
            ballInCourt: .mine,
            payload: .comms(CommsBody(summary: "s")),
            verdict: Verdict(action: "delegate", confidence: 0.8, verdictId: "vd_1")
        )
    }

    // MARK: - 1) Head entry

    func testHeadEntryFromVerdictItem() async {
        let core = QueueHeadTimelineCore(source: StubSource(outcome: .item(headItem())))
        let state = await core.resolve(previous: nil)
        XCTAssertEqual(state, .head(action: "delegate", title: "WHS-346 export"))
    }

    func testHeadEntryFallsBackToReviewWhenVerdictActionMissing() async {
        let item = TriageItem(
            id: "wi_2", source: "gmail", kind: .email, title: "no-verdict item",
            ballInCourt: .mine, payload: .comms(CommsBody(summary: "s"))
        )
        let core = QueueHeadTimelineCore(source: StubSource(outcome: .item(item)))
        let state = await core.resolve(previous: nil)
        XCTAssertEqual(state, .head(action: "review", title: "no-verdict item"))
    }

    // MARK: - 2) Clear entry

    func testClearEntryOnEmptyQueue() async {
        // Empty is a REAL successful clear — it must NOT retain a prior head.
        let core = QueueHeadTimelineCore(source: StubSource(outcome: .empty))
        let state = await core.resolve(previous: .head(action: "defer", title: "stale"))
        XCTAssertEqual(state, .clear)
    }

    // MARK: - 3) Retained entry on failure

    func testRetainedEntryOnFetchFailure() async {
        let previous = QueueHeadState.head(action: "delegate", title: "WHS-346 export")
        let core = QueueHeadTimelineCore(source: StubSource(outcome: .failed))
        let state = await core.resolve(previous: previous)
        XCTAssertEqual(state, previous, "a fetch failure retains the last good entry")
    }

    func testFailureWithNoPriorEntryFallsToClear() async {
        // First-ever render + a failure has nothing to retain -> clear (never spins).
        let core = QueueHeadTimelineCore(source: StubSource(outcome: .failed))
        let state = await core.resolve(previous: nil)
        XCTAssertEqual(state, .clear)
    }
}
