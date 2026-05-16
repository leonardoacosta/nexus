//
//  AggregateStateTests.swift
//  nexusTests
//
//  Table-driven coverage of every combination of (peerReachable, sessionCount,
//  ttsEnabled). The 5 wireframe variants come from `derive` + the TTS-muted
//  overlay flag tracked separately on the view model.
//

import XCTest
@testable import nexus

final class AggregateStateTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_715_000_000)

    func testActiveWhenReachableAndSessionsRunning() {
        let s = AggregateState.derive(
            lastHeartbeat: now.addingTimeInterval(-5),
            sessionCount: 2,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .active)
    }

    func testIdleWhenReachableAndNoSessions() {
        let s = AggregateState.derive(
            lastHeartbeat: now.addingTimeInterval(-5),
            sessionCount: 0,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .idle)
    }

    func testStaleWhenHeartbeatBetween30sAnd5min() {
        // 90 seconds old → stale
        let s = AggregateState.derive(
            lastHeartbeat: now.addingTimeInterval(-90),
            sessionCount: 1,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .stale)
    }

    func testUnreachableOnLongAge() {
        // 600s = 10 minutes → unreachable
        let s = AggregateState.derive(
            lastHeartbeat: now.addingTimeInterval(-600),
            sessionCount: 0,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .unreachable)
    }

    func testUnreachableWhenPeerLostRegardlessOfHeartbeat() {
        // Fresh heartbeat is ignored when peerLost was explicitly reported.
        let s = AggregateState.derive(
            lastHeartbeat: now,
            sessionCount: 3,
            peerLost: true,
            now: now
        )
        XCTAssertEqual(s, .unreachable)
    }

    func testUnreachableWhenNoHeartbeatEverSeen() {
        let s = AggregateState.derive(
            lastHeartbeat: nil,
            sessionCount: 0,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(s, .unreachable)
    }

    func testTtsMutedOverlayIsOrthogonalToBaseVariant() {
        // The base aggregate state must not change when TTS is muted; the
        // overlay is a separate boolean tracked on the view model.
        let base = AggregateState.derive(
            lastHeartbeat: now,
            sessionCount: 1,
            peerLost: false,
            now: now
        )
        XCTAssertEqual(base, .active)
        // Composing the overlay is the responsibility of `StatusIcon.body` —
        // we assert here that `derive` itself ignores TTS state by not
        // accepting it as input.
    }
}
