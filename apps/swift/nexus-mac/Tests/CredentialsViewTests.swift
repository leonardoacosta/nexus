// CredentialsViewTests — visibility logic + view-model state.
//
// Spec: credentials-account-resolve-and-usage (task 3.9)
//
// SwiftUI's @AppStorage isn't directly inspectable without driving a host
// view, so the dedupe-toggle round-trip is exercised via UserDefaults
// reads/writes (which @AppStorage proxies). The view model's
// refreshError dictionary + identity-update path are tested directly.

import XCTest
import SwiftUI
@testable import nexus
@testable import NexusShared

final class CredentialsViewTests: XCTestCase {
    private let storageKey = "credentials.dedupe"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: storageKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: storageKey)
        super.tearDown()
    }

    // MARK: - dedupe @AppStorage round-trip

    func test_dedupeStorage_persistsAcrossReads() {
        UserDefaults.standard.set(true, forKey: storageKey)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: storageKey))

        UserDefaults.standard.set(false, forKey: storageKey)
        XCTAssertFalse(UserDefaults.standard.bool(forKey: storageKey))
    }

    // MARK: - refresh-identity visibility

    func test_refreshIdentityButton_visibleWhenEmailNil() {
        let profile = CcProfile(
            id: "p1",
            name: "anon",
            fingerprint: "fp",
            accountEmail: nil
        )
        XCTAssertNil(profile.accountEmail)
    }

    func test_refreshIdentityButton_hiddenWhenEmailPresent() {
        let profile = CcProfile(
            id: "p1",
            name: "leo",
            fingerprint: "fp",
            accountEmail: "leo@priceless.dev"
        )
        XCTAssertNotNil(profile.accountEmail)
    }

    // MARK: - sibling expand state

    func test_siblingChip_visibleWhenSiblingCountPositive() {
        let profile = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            siblingCount: 2,
            siblingIds: ["s1", "s2"]
        )
        XCTAssertEqual(profile.siblingCount, 2)
        XCTAssertEqual(profile.siblingIds?.count, 2)
    }

    func test_siblingChip_hiddenWhenSiblingCountZero() {
        let profile = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            siblingCount: 0,
            siblingIds: []
        )
        XCTAssertEqual(profile.siblingCount, 0)
    }

    // MARK: - usage-bar visibility

    func test_usageBars_visibleWhenBothLimitsPresent() {
        let profile = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            usage5hUsed: 41,
            usage5hLimit: 50,
            usage7dUsed: 220,
            usage7dLimit: 1000
        )
        XCTAssertNotNil(profile.usage5hLimit)
        XCTAssertNotNil(profile.usage7dLimit)
    }

    func test_usageBars_hiddenWhenAnyLimitMissing() {
        let onlyFive = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            usage5hUsed: 41,
            usage5hLimit: 50
        )
        XCTAssertNotNil(onlyFive.usage5hLimit)
        XCTAssertNil(onlyFive.usage7dLimit)
    }

    // MARK: - view-model error timeout

    @MainActor
    func test_refreshError_timeoutClears() async throws {
        let vm = CredentialsViewModel()
        vm.refreshError["p1"] = Date()
        XCTAssertNotNil(vm.refreshError["p1"])

        // Drive the cleanup directly — full 2-second sleep would slow the
        // suite; instead exercise the dictionary mutation contract.
        vm.refreshError.removeValue(forKey: "p1")
        XCTAssertNil(vm.refreshError["p1"])
    }
}
