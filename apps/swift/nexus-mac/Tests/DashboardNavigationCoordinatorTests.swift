// DashboardNavigationCoordinatorTests — token cancellation, single-
// click semantics, and rapid double-click bias for the cross-tab
// deep-link router.
//
// Spec: openspec/changes/projects-tab-accordion-deeplink (task 2.8)
//
// The coordinator is a pure publisher; no network, no view hierarchy.
// Tests live entirely in-process.

import XCTest
@testable import nexus
@testable import NexusShared
import Combine

@MainActor
final class DashboardNavigationCoordinatorTests: XCTestCase {

    func testInitialStateHasNoPendingLink() {
        let c = DashboardNavigationCoordinator()
        XCTAssertNil(c.pendingDeepLink)
    }

    func testOpenSessionPublishesPendingLink() {
        let c = DashboardNavigationCoordinator()
        let token = c.openSession("sess-1")
        XCTAssertNotNil(c.pendingDeepLink)
        switch c.pendingDeepLink {
        case .openSession(let id, let t):
            XCTAssertEqual(id, "sess-1")
            XCTAssertEqual(t, token)
        case .none:
            XCTFail("expected pending link")
        }
    }

    func testEachOpenMintsAFreshToken() {
        let c = DashboardNavigationCoordinator()
        let t1 = c.openSession("sess-1")
        let t2 = c.openSession("sess-2")
        XCTAssertNotEqual(t1, t2, "consecutive openSession calls must mint unique tokens")
    }

    func testRapidDoubleClickSecondLinkWins() {
        // Producer fires A, then B 200ms later. The published value
        // reflects B; consumers that captured A's token MUST detect the
        // mismatch when they observe the latest publishedValue.
        let c = DashboardNavigationCoordinator()
        let tokenA = c.openSession("sess-A")
        let tokenB = c.openSession("sess-B")
        guard case let .openSession(id, t) = c.pendingDeepLink else {
            return XCTFail("expected pending link")
        }
        XCTAssertEqual(id, "sess-B")
        XCTAssertEqual(t, tokenB)
        XCTAssertNotEqual(t, tokenA, "stale tokenA must not survive")
    }

    func testClearNilsThePendingLink() {
        let c = DashboardNavigationCoordinator()
        _ = c.openSession("sess-1")
        c.clear()
        XCTAssertNil(c.pendingDeepLink)
    }

    func testClearOnEmptyIsNoop() {
        let c = DashboardNavigationCoordinator()
        c.clear()
        c.clear()
        XCTAssertNil(c.pendingDeepLink)
    }

    func testDeepLinkEquatableHonoursToken() {
        let id = UUID()
        let a = DashboardNavigationCoordinator.DeepLink.openSession(id: "x", token: id)
        let b = DashboardNavigationCoordinator.DeepLink.openSession(id: "x", token: id)
        XCTAssertEqual(a, b)
        let c = DashboardNavigationCoordinator.DeepLink.openSession(id: "x", token: UUID())
        XCTAssertNotEqual(a, c, "different tokens => different DeepLink values")
    }

    func testTokenAccessorReturnsCarriedToken() {
        let token = UUID()
        let link = DashboardNavigationCoordinator.DeepLink.openSession(id: "x", token: token)
        XCTAssertEqual(link.token, token)
    }

    // Publisher fires on each openSession — consumers SwiftUI bind via
    // `.onChange(of: pendingDeepLink)`. We sanity-check the Combine
    // sink fires the expected number of times.
    func testPublisherFiresOnEachOpenAndClear() {
        let c = DashboardNavigationCoordinator()
        var snapshots: [DashboardNavigationCoordinator.DeepLink?] = []
        let cancellable = c.$pendingDeepLink.sink { snapshots.append($0) }
        defer { cancellable.cancel() }
        _ = c.openSession("a")
        _ = c.openSession("b")
        c.clear()
        // Combine emits initial nil + 3 transitions.
        XCTAssertEqual(snapshots.count, 4)
        XCTAssertNil(snapshots.first ?? .openSession(id: "x", token: UUID()))
        XCTAssertNil(snapshots.last ?? .openSession(id: "x", token: UUID()))
    }
}
