// SessionSearchTests — pin the pure fuzzy-filter behavior used by the
// nexus-mac dashboard search (`/` to search, ESC to exit).
//
// Bead: nx-0pfb. The match logic lives on `Session` (NexusShared) so it is
// exercised here without the SwiftUI view hierarchy — same pattern as
// SessionRowTests for the project-label ladder.

import XCTest
@testable import NexusShared

final class SessionSearchTests: XCTestCase {
    private func session(
        id: String,
        status: String = "active",
        machine: String? = nil,
        branch: String? = nil,
        gitOwnerRepo: String? = nil
    ) -> Session {
        Session(
            id: id,
            machine: machine,
            status: status,
            branch: branch,
            gitOwnerRepo: gitOwnerRepo
        )
    }

    private var fixture: [Session] {
        [
            session(id: "s1", status: "active", machine: "homelab-01", branch: "main", gitOwnerRepo: "leonardoacosta/oo"),
            session(id: "s2", status: "idle", machine: "mac-mini-02", branch: "feature/x", gitOwnerRepo: "leonardoacosta/nexus"),
            session(id: "s3", status: "active", machine: "workstation", branch: nil, gitOwnerRepo: "brownandbrowninc/wholesale"),
        ]
    }

    /// Empty query returns the full list unchanged (exiting search mode).
    func testEmptyQueryReturnsFullList() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "").map(\.id), ["s1", "s2", "s3"])
    }

    /// Whitespace-only query also returns the full list.
    func testWhitespaceQueryReturnsFullList() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "   ").map(\.id), ["s1", "s2", "s3"])
    }

    /// No-match query returns an empty list.
    func testNoMatchReturnsEmpty() {
        XCTAssertTrue(Session.fuzzyFilter(fixture, query: "zzzzz").isEmpty)
    }

    /// Substring on the project label matches (case-insensitive).
    func testProjectNameSubstringMatch() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "nexus").map(\.id), ["s2"])
    }

    /// Filter by session status.
    func testStatusMatch() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "idle").map(\.id), ["s2"])
    }

    /// Filter by agent hostname (originAgent -> machine fallback).
    func testHostnameMatch() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "workstation").map(\.id), ["s3"])
    }

    /// Non-contiguous subsequence match — "lco" is a subsequence of
    /// "leonardoacosta", so both leonardoacosta/* rows match.
    func testSubsequenceMatch() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "lco").map(\.id), ["s1", "s2"])
    }

    /// Case-insensitive on both needle and haystack.
    func testCaseInsensitive() {
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "HOMELAB").map(\.id), ["s1"])
    }

    /// Order is preserved (caller sorts afterward).
    func testOrderPreserved() {
        // "a" is a subsequence of every fixture label/status; result keeps input order.
        XCTAssertEqual(Session.fuzzyFilter(fixture, query: "a").map(\.id), ["s1", "s2", "s3"])
    }

    /// Direct subsequence-matcher unit checks.
    func testSubsequenceMatcherEdgeCases() {
        XCTAssertTrue(Session.fuzzySubsequenceMatch(needle: "", haystack: "anything"))
        XCTAssertTrue(Session.fuzzySubsequenceMatch(needle: "oo", haystack: "leonardoacosta/oo"))
        XCTAssertFalse(Session.fuzzySubsequenceMatch(needle: "ox", haystack: "leonardoacosta/oo"))
        XCTAssertFalse(Session.fuzzySubsequenceMatch(needle: "abc", haystack: "ab"))
    }
}
