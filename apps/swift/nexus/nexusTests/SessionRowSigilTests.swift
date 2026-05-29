//
//  SessionRowSigilTests.swift
//  nexusTests
//
//  Unit tests for the pure decision seams extracted out of the SessionRow
//  view body (nx-mld93): the agent-state sigil mapping and the subtitle
//  fallback. Asserting against the rendered SwiftUI view is unreliable, so
//  SessionRow exposes `sigilStyle(for:)`, `SigilToken`, and `subtitle(...)`
//  as pure functions; the view body merely calls them. These tests pin the
//  mapping the UI batch chose for openspec/changes/session-enrichment.
//

import XCTest
import SwiftUI
import NexusShared
@testable import nexus

final class SessionRowSigilTests: XCTestCase {

    // MARK: - Sigil mapping (token + filled treatment)

    func testBlockedMapsToPhosphorFilled() {
        let style = SessionRow.sigilStyle(for: .blocked)
        XCTAssertEqual(style.token, .phosphor)
        XCTAssertTrue(style.filled, "blocked is the only filled+glow state")
        XCTAssertEqual(style.token.color, Color.nx.phosphor)
    }

    func testWaitingMapsToAmberHollow() {
        let style = SessionRow.sigilStyle(for: .waiting)
        XCTAssertEqual(style.token, .amber)
        XCTAssertFalse(style.filled, "waiting renders as a hollow outline")
        XCTAssertEqual(style.token.color, Color.nx.amber)
    }

    func testReadyMapsToPhosphorDimHollow() {
        let style = SessionRow.sigilStyle(for: .ready)
        XCTAssertEqual(style.token, .phosphorDim)
        XCTAssertFalse(style.filled, "ready renders as a hollow outline")
        XCTAssertEqual(style.token.color, Color.nx.phosphorDim)
    }

    func testNilMapsToNeutralHairlineHollow() {
        let style = SessionRow.sigilStyle(for: nil)
        XCTAssertEqual(style.token, .neutral)
        XCTAssertFalse(style.filled, "the legacy/unknown state renders hollow")
        XCTAssertEqual(style.token.color, Color.nx.hairlineStrong)
    }

    /// Only `.blocked` is filled; every other state (including nil) is hollow.
    func testOnlyBlockedIsFilled() {
        let states: [AgentState?] = [.blocked, .waiting, .ready, nil]
        for state in states {
            let filled = SessionRow.sigilStyle(for: state).filled
            XCTAssertEqual(filled, state == .blocked,
                           "unexpected filled treatment for \(String(describing: state))")
        }
    }

    /// Each non-nil state maps to a distinct token — no two share a tint.
    func testEachStateHasDistinctToken() {
        let tokens = [
            SessionRow.sigilStyle(for: .blocked).token,
            SessionRow.sigilStyle(for: .waiting).token,
            SessionRow.sigilStyle(for: .ready).token,
            SessionRow.sigilStyle(for: nil).token,
        ]
        XCTAssertEqual(Set(tokens.map(String.init(describing:))).count, tokens.count,
                       "sigil tokens collide across states")
    }

    // MARK: - Subtitle fallback (`project · branch` vs `project`)

    func testSubtitleJoinsProjectAndBranch() {
        XCTAssertEqual(SessionRow.subtitle(project: "nx", branch: "main"), "nx · main")
    }

    func testSubtitleFallsBackToProjectWhenBranchNil() {
        XCTAssertEqual(SessionRow.subtitle(project: "nx", branch: nil), "nx")
    }

    func testSubtitleFallsBackToProjectWhenBranchEmpty() {
        XCTAssertEqual(SessionRow.subtitle(project: "nx", branch: ""), "nx")
    }
}
