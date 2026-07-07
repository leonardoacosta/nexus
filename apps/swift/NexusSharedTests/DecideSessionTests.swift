// DecideSessionTests — the pure state-transition math for the decide pilot
// (openspec/changes/add-decide-flow-menubar, NexusShared task 2.7).
//
// All transitions are pure + synchronous (no network), so these tests exercise:
// advance (commitDecision), skip hold-rank, forced-decision at the 3rd skip,
// done phase, and the paused round-trip — with zero I/O.

import XCTest
@testable import NexusShared

final class DecideSessionTests: XCTestCase {

    // MARK: - Fixtures

    /// A verdict-BEARING (actionable) card with the given id.
    private func verdictCard(_ id: String) -> TriageItem {
        TriageItem(
            id: id, source: "ado", kind: .workItem, title: "card \(id)",
            ballInCourt: .mine,
            payload: .comms(CommsBody(summary: "s")),
            verdict: Verdict(action: "delegate", confidence: 0.8, verdictId: "vd_\(id)")
        )
    }

    /// A verdict-LESS card (skip-only, never forced).
    private func plainCard(_ id: String) -> TriageItem {
        TriageItem(
            id: id, source: "gmail", kind: .email, title: "plain \(id)",
            ballInCourt: .mine, payload: .comms(CommsBody(summary: "s"))
        )
    }

    // MARK: - Seed + progress

    func testSeedSetsCurrentAndProgress() {
        let s = DecideSession()
        s.seed([verdictCard("a"), verdictCard("b"), verdictCard("c")])
        XCTAssertEqual(s.current?.id, "a")
        XCTAssertEqual(s.sessionSize, 3)
        XCTAssertEqual(s.decidedCount, 0)
        XCTAssertEqual(s.phase, .deck)
        XCTAssertEqual(s.progressLabel, "1 of 3")
    }

    // MARK: - Advance (commitDecision)

    func testCommitDecisionAdvancesAndCompletes() {
        let s = DecideSession()
        s.seed([verdictCard("a"), verdictCard("b")])

        s.commitDecision()
        XCTAssertEqual(s.decidedCount, 1)
        XCTAssertEqual(s.current?.id, "b", "next card shifts into the current slot")
        XCTAssertEqual(s.phase, .deck)
        XCTAssertEqual(s.progressLabel, "2 of 2")

        s.commitDecision()
        XCTAssertEqual(s.decidedCount, 2)
        XCTAssertNil(s.current)
        XCTAssertEqual(s.phase, .done)
    }

    // MARK: - Skip hold-rank

    func testSkipHoldsRankAndMovesCardBehind() {
        let s = DecideSession()
        s.seed([verdictCard("a"), verdictCard("b"), verdictCard("c")])

        s.skip()

        // 'a' moved behind the current position; 'b' is now current. Only 'a'
        // moved — 'c' order preserved (holds rank, no re-rank).
        XCTAssertEqual(s.current?.id, "b")
        XCTAssertEqual(s.items.map(\.id), ["b", "a", "c"])
        XCTAssertEqual(s.skipCount(for: "a"), 1)
        XCTAssertEqual(s.sessionSize, 3, "skip never changes the session size")
        XCTAssertEqual(s.decidedCount, 0, "a skip is not a decision")
    }

    // MARK: - Forced-decision at the 3rd skip

    func testThirdSkipForcesDecisionOnVerdictCard() {
        let s = DecideSession()
        let a = verdictCard("a")
        s.seed([a])   // single card — skip re-inserts in place

        s.skip()
        XCTAssertFalse(s.isForced(a), "1 skip is not forced")
        s.skip()
        XCTAssertFalse(s.isForced(a), "2 skips is not forced")
        s.skip()
        XCTAssertTrue(s.isForced(a), "3rd skip forces a decision")
        XCTAssertEqual(s.skipCount(for: "a"), 3)

        // A forced card cannot be skipped further — the 4th skip is a no-op.
        s.skip()
        XCTAssertEqual(s.skipCount(for: "a"), 3)
        XCTAssertTrue(s.currentIsForced)
    }

    func testVerdictLessCardIsNeverForced() {
        let s = DecideSession()
        let p = plainCard("p")
        s.seed([p])

        for _ in 0..<5 { s.skip() }

        XCTAssertFalse(s.isForced(p), "verdict-less cards are skip-only, never forced")
        XCTAssertEqual(s.skipCount(for: "p"), 5)
    }

    // MARK: - Done phase

    func testEmptySeedIsImmediatelyDone() {
        let s = DecideSession()
        s.seed([])
        XCTAssertEqual(s.phase, .done)
        XCTAssertEqual(s.sessionSize, 0)
        XCTAssertNil(s.current)
    }

    // MARK: - Paused round-trip

    func testPausedRoundTripDoesNotAdvance() {
        let s = DecideSession()
        s.seed([verdictCard("a"), verdictCard("b")])

        s.markPaused()
        XCTAssertTrue(s.paused)
        XCTAssertEqual(s.current?.id, "a", "pausing never advances the deck")
        XCTAssertEqual(s.phase, .deck)

        s.resume()
        XCTAssertFalse(s.paused)
        XCTAssertEqual(s.current?.id, "a")
    }

    // MARK: - Override / peek phase transitions

    func testOverridePhaseTransitions() {
        let s = DecideSession()
        s.seed([verdictCard("a")])

        s.beginOverride()
        XCTAssertEqual(s.phase, .overriding)
        s.cancelOverride()
        XCTAssertEqual(s.phase, .deck)
    }

    func testOverrideRequiresActionableVerdict() {
        let s = DecideSession()
        s.seed([plainCard("p")])
        s.beginOverride()
        XCTAssertEqual(s.phase, .deck, "a verdict-less card cannot enter override")
    }

    func testPeekPhaseTransitions() {
        let s = DecideSession()
        s.seed([verdictCard("a")])
        s.beginPeek()
        XCTAssertEqual(s.phase, .peeking)
        s.endPeek()
        XCTAssertEqual(s.phase, .deck)
    }

    // MARK: - Accept action mapping

    func testAcceptActionMapsFromVerdict() {
        let s = DecideSession()
        s.seed([verdictCard("a")])
        XCTAssertEqual(s.acceptAction, .delegate)
    }
}
