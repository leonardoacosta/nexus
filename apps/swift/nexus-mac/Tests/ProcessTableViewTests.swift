// ProcessTableViewTests — verify the process-table UI logic surfaces the
// invariants from `health-process-table-view` and `health-process-machine
// -selector-reuse`. These tests exercise pure functions and the view-model;
// SwiftUI render snapshots are out of scope for the unit gate.
//
// Spec: openspec/changes/health-tab-process-view (task 2.6).

import XCTest
import SwiftUI
@testable import nexus
@testable import NexusShared

final class ProcessTableViewTests: XCTestCase {

    // ── Fixtures ─────────────────────────────────────────────────────────

    private func processInfo(
        pid: Int = 100,
        name: String = "claude",
        cpu: Double = 50,
        ram: Double = 10,
        user: String? = "leo",
        command: String? = "/usr/local/bin/claude"
    ) -> HealthMetrics.ProcessInfo {
        HealthMetrics.ProcessInfo(
            pid: pid,
            name: name,
            cpuPercent: cpu,
            ramPercent: ram,
            command: command,
            user: user,
            state: "S"
        )
    }

    // ── Populated rendering ──────────────────────────────────────────────

    func test_populatedRendering_initialisesWithLists() {
        let response = HealthProcessesResponse(
            topCpu: [processInfo(pid: 1, name: "claude")],
            topRam: [processInfo(pid: 2, name: "chrome", cpu: 5, ram: 40)],
            collectedAt: Date()
        )
        // Acceptance: constructing the view with non-empty lists succeeds
        // and the response surface matches.
        let view = ProcessTableView(processes: response)
        XCTAssertEqual(view.processes.topCpu.count, 1)
        XCTAssertEqual(view.processes.topRam.count, 1)
        XCTAssertEqual(view.processes.topCpu.first?.name, "claude")
    }

    // ── Empty hide-section ───────────────────────────────────────────────

    func test_emptyResponse_processTableViewModelHandlesEmpty() {
        // The hide-section gate is enforced by HealthView (it doesn't
        // construct ProcessTableView when both lists are empty), but the
        // table itself MUST not crash if it's somehow handed an empty
        // payload. This guards against future regressions where the parent
        // forgets the empty check.
        let response = HealthProcessesResponse(
            topCpu: [],
            topRam: [],
            collectedAt: nil
        )
        let view = ProcessTableView(processes: response)
        XCTAssertTrue(view.processes.topCpu.isEmpty)
        XCTAssertTrue(view.processes.topRam.isEmpty)
    }

    // ── Numeric-uid passthrough ──────────────────────────────────────────

    func test_renderUser_numericString_prefixesUid() {
        // Linux returns numeric uids; the UI rewrites them to `uid:NNNN`
        // so users can distinguish "actually a user named 1000" from
        // "the process owner is uid 1000".
        XCTAssertEqual(ProcessTableTestProbe.renderUser("1000"), "uid:1000")
        XCTAssertEqual(ProcessTableTestProbe.renderUser("0"), "uid:0")
    }

    func test_renderUser_alphaString_passesThrough() {
        XCTAssertEqual(ProcessTableTestProbe.renderUser("leo"), "leo")
        // Mixed alphanumeric — NOT a pure numeric uid, no prefix.
        XCTAssertEqual(ProcessTableTestProbe.renderUser("user1000"), "user1000")
    }

    func test_renderUser_nilOrEmpty_returnsNil() {
        XCTAssertNil(ProcessTableTestProbe.renderUser(nil))
        XCTAssertNil(ProcessTableTestProbe.renderUser(""))
    }

    // ── Stale-snapshot toggle at the 30s boundary ────────────────────────

    func test_staleness_under30s_isFresh() {
        let now = Date()
        let collected = now.addingTimeInterval(-29)
        let result = ProcessTableTestProbe.staleness(
            collectedAt: collected,
            now: now
        )
        XCTAssertFalse(result.isStale)
    }

    func test_staleness_exactly30s_isFresh() {
        // The contract is "older than 30s" — strict > so 30s exactly
        // remains fresh. Prevents jittery toggling right at the boundary.
        let now = Date()
        let collected = now.addingTimeInterval(-30)
        let result = ProcessTableTestProbe.staleness(
            collectedAt: collected,
            now: now
        )
        XCTAssertFalse(result.isStale)
    }

    func test_staleness_over30s_isStale() {
        let now = Date()
        let collected = now.addingTimeInterval(-31)
        let result = ProcessTableTestProbe.staleness(
            collectedAt: collected,
            now: now
        )
        XCTAssertTrue(result.isStale)
        XCTAssertNotNil(result.label)
    }

    func test_staleness_collectedAtNil_isFresh() {
        // Warming-up snapshot — collectedAt nil. Treated as fresh so the
        // hide-section branch (in the parent) gets to decide instead.
        let result = ProcessTableTestProbe.staleness(
            collectedAt: nil,
            now: Date()
        )
        XCTAssertFalse(result.isStale)
        XCTAssertNil(result.label)
    }

    // Machine-switch clearing moved to the board's ProcessTablePopover
    // (refocus-board-shell task 3.5) — HealthViewModel was deleted with the
    // Health tab, so its clear-on-switch test retired with it.
}
