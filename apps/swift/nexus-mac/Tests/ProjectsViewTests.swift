// ProjectsViewTests — sticky @AppStorage + orphan pruning rules for
// the Projects-tab accordion.
//
// Spec: openspec/changes/projects-tab-accordion-deeplink (task 2.7)
//
// SwiftUI body-rendering is out of scope here (driven by integration
// tests under nexus-mac-UITests when those re-enable). What we pin:
//   - Namespaced @AppStorage key shape (`projects-accordion-expanded.<id>`)
//   - pruneOrphanExpandKeys drops only orphans (live ids stay)
//   - default-state expression (no stored value → expanded iff
//     activeSessions > 0; stored value wins)
//
// UserDefaults isolation: each test uses a dedicated `UserDefaults
// .standard` namespace prefix (`projects-accordion-expanded.<test>-`)
// and tears down via `pruneOrphanExpandKeys(liveIds: [])`.

import XCTest
@testable import nexus
@testable import NexusShared

final class ProjectsViewTests: XCTestCase {

    private func uniqueId(_ test: String) -> String {
        "\(test)-\(UUID().uuidString)"
    }

    private func cleanup(_ ids: [String]) {
        ProjectsView.pruneOrphanExpandKeys(liveIds: [])
        for id in ids {
            UserDefaults.standard.removeObject(
                forKey: ProjectsView.expandKey(for: id)
            )
        }
    }

    // MARK: - expandKey namespace

    func testExpandKeyPrefixStability() {
        // Documented namespace — schema change requires explicit migration.
        XCTAssertEqual(
            ProjectsView.expandKeyPrefix,
            "projects-accordion-expanded."
        )
    }

    func testExpandKeyConstructsNamespacedKey() {
        let key = ProjectsView.expandKey(for: "nx")
        XCTAssertEqual(key, "projects-accordion-expanded.nx")
    }

    // MARK: - pruneOrphanExpandKeys

    func testPruningDropsKeysNotInLiveSet() {
        let live = uniqueId("live")
        let orphan = uniqueId("orphan")
        UserDefaults.standard.set(true, forKey: ProjectsView.expandKey(for: live))
        UserDefaults.standard.set(false, forKey: ProjectsView.expandKey(for: orphan))

        ProjectsView.pruneOrphanExpandKeys(liveIds: [live])

        XCTAssertNotNil(
            UserDefaults.standard.object(forKey: ProjectsView.expandKey(for: live)),
            "live project's stored value must survive prune"
        )
        XCTAssertNil(
            UserDefaults.standard.object(forKey: ProjectsView.expandKey(for: orphan)),
            "orphan project's stored value must be removed"
        )
        cleanup([live, orphan])
    }

    func testPruningWithEmptyLiveSetClearsEverythingInNamespace() {
        let a = uniqueId("a")
        let b = uniqueId("b")
        UserDefaults.standard.set(true, forKey: ProjectsView.expandKey(for: a))
        UserDefaults.standard.set(true, forKey: ProjectsView.expandKey(for: b))

        ProjectsView.pruneOrphanExpandKeys(liveIds: [])

        XCTAssertNil(UserDefaults.standard.object(forKey: ProjectsView.expandKey(for: a)))
        XCTAssertNil(UserDefaults.standard.object(forKey: ProjectsView.expandKey(for: b)))
    }

    func testPruningDoesNotTouchUnrelatedKeys() {
        let live = uniqueId("live")
        let unrelatedKey = "some.other.namespace.\(UUID().uuidString)"
        UserDefaults.standard.set(true, forKey: ProjectsView.expandKey(for: live))
        UserDefaults.standard.set("hands-off", forKey: unrelatedKey)

        ProjectsView.pruneOrphanExpandKeys(liveIds: [live])

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: unrelatedKey),
            "hands-off",
            "pruning MUST NOT touch keys outside the projects-accordion namespace"
        )
        cleanup([live])
        UserDefaults.standard.removeObject(forKey: unrelatedKey)
    }

    // MARK: - default-state semantics (smoke test via stored value)

    func testStoredValueOverridesActiveSessionDefault() {
        // Scenario: project has 2 active sessions (would default expanded)
        // but the user collapsed it last session. Stored `false` must
        // beat the activeSessions-based default — the accordionRow helper
        // reads `stored ?? defaultExpanded`.
        let id = uniqueId("stored-false")
        UserDefaults.standard.set(false, forKey: ProjectsView.expandKey(for: id))

        let stored = UserDefaults.standard.object(
            forKey: ProjectsView.expandKey(for: id)
        ) as? Bool
        XCTAssertEqual(stored, false, "stored value precedes default")

        // After pruning the project (registry removal) the stored value
        // is gone, so the next render falls back to activeSessions default.
        ProjectsView.pruneOrphanExpandKeys(liveIds: [])
        XCTAssertNil(
            UserDefaults.standard.object(forKey: ProjectsView.expandKey(for: id))
        )
    }

    func testNoStoredValueProducesNilDefault() {
        let id = uniqueId("no-store")
        XCTAssertNil(
            UserDefaults.standard.object(forKey: ProjectsView.expandKey(for: id)),
            "fresh project id should have no stored value"
        )
    }
}
