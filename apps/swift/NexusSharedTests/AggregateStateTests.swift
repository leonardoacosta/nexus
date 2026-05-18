// AggregateStateTests — verify AggregateState.derive over the documented
// thresholds (30 s stale, 5 min unreachable, peer-lost short-circuit).
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.7)

import XCTest
@testable import NexusShared

final class AggregateStateTests: XCTestCase {
    func testPeerLostShortCircuitsToUnreachable() {
        let s = AggregateState.derive(
            lastHeartbeat: Date(),
            sessionCount: 5,
            peerLost: true
        )
        XCTAssertEqual(s, .unreachable)
    }

    func testNoHeartbeatIsUnreachable() {
        let s = AggregateState.derive(
            lastHeartbeat: nil,
            sessionCount: 0,
            peerLost: false
        )
        XCTAssertEqual(s, .unreachable)
    }

    func testFreshHeartbeatWithSessionsIsActive() {
        let s = AggregateState.derive(
            lastHeartbeat: Date(),
            sessionCount: 1,
            peerLost: false
        )
        XCTAssertEqual(s, .active)
    }

    func testFreshHeartbeatNoSessionsIsIdle() {
        let s = AggregateState.derive(
            lastHeartbeat: Date(),
            sessionCount: 0,
            peerLost: false
        )
        XCTAssertEqual(s, .idle)
    }

    func testHeartbeatBetween30sAnd5MinIsStale() {
        let now = Date()
        let staleHb = now.addingTimeInterval(-60) // 1 min old
        let s = AggregateState.derive(
            lastHeartbeat: staleHb,
            sessionCount: 1,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .stale)
    }

    func testHeartbeatOver5MinIsUnreachable() {
        let now = Date()
        let deadHb = now.addingTimeInterval(-360) // 6 min old
        let s = AggregateState.derive(
            lastHeartbeat: deadHb,
            sessionCount: 1,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .unreachable)
    }
}
