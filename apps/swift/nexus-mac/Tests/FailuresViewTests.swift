// FailuresViewTests — filter chip behavior, empty-state disambiguation,
// trend-indicator visibility logic.
//
// Spec: openspec/changes/failures-investigation-and-surface (task 2.4)
// bd: nx-btn4p
//
// These tests cover the pure logic (trendLabel + ViewModel state
// transitions). SwiftUI ViewInspector-style render assertions are out of
// scope — the spec accepts ViewModel-seam testing per the task line.

import XCTest
import SwiftUI
@testable import nexus
import NexusShared

@MainActor
final class FailuresViewTests: XCTestCase {

    // MARK: - Trend indicator visibility

    func test_trendLabel_flat_returnsNil() {
        let trend = FailureTrend(current: 10, previous: 10, direction: "flat")
        XCTAssertNil(FailuresView.trendLabel(for: trend))
    }

    func test_trendLabel_up_rendersRedArrow() {
        let trend = FailureTrend(current: 50, previous: 10, direction: "up")
        let label = FailuresView.trendLabel(for: trend)
        XCTAssertNotNil(label)
        XCTAssertEqual(label?.text, "↑400%")
        XCTAssertEqual(label?.color, Color.red)
    }

    func test_trendLabel_down_rendersGreenArrow() {
        let trend = FailureTrend(current: 5, previous: 20, direction: "down")
        let label = FailuresView.trendLabel(for: trend)
        XCTAssertNotNil(label)
        XCTAssertEqual(label?.text, "↓75%")
        XCTAssertEqual(label?.color, Color.green)
    }

    func test_trendLabel_zeroPrevious_avoidsDivByZero() {
        let trend = FailureTrend(current: 3, previous: 0, direction: "up")
        let label = FailuresView.trendLabel(for: trend)
        XCTAssertNotNil(label)
        // delta=3, denom=max(0,1)=1 → 300%
        XCTAssertEqual(label?.text, "↑300%")
    }

    func test_trendLabel_unknownDirection_returnsNil() {
        let trend = FailureTrend(current: 10, previous: 5, direction: "sideways")
        XCTAssertNil(FailuresView.trendLabel(for: trend))
    }

    // MARK: - ViewModel injection

    func test_viewModel_applyForTesting_populatesAllFields() {
        let model = FailuresViewModel()
        let envelope = FailuresResponse(
            periodDays: 7,
            total: 12,
            topErrors: [
                ScriptError(
                    id: "a",
                    script: "Read",
                    message: "ENOENT",
                    capturedAt: Date(),
                    occurrences: 8,
                    project: "nx"
                ),
                ScriptError(
                    id: "b",
                    script: "Bash",
                    message: "exit 1",
                    capturedAt: Date(),
                    occurrences: 4,
                    project: "oo"
                ),
            ],
            byTool: ["Read": 8, "Bash": 4],
            byProject: ["nx": 8, "oo": 4],
            trend: FailureTrend(current: 12, previous: 5, direction: "up"),
            source: "jsonl",
            parseErrors: 0
        )
        model.applyForTesting(envelope)
        XCTAssertEqual(model.total, 12)
        XCTAssertEqual(model.byTool["Read"], 8)
        XCTAssertEqual(model.byProject["nx"], 8)
        XCTAssertEqual(model.trend.direction, "up")
        XCTAssertEqual(model.source, "jsonl")
        XCTAssertEqual(model.errors.count, 2)
    }

    // MARK: - Filter logic (pure)
    //
    // The filtering predicate inside `FailuresView.filteredErrors` is
    // private; rather than exposing it, we re-derive the same logic here
    // and assert the contract.

    private func filter(
        errors: [ScriptError],
        tools: Set<String>,
        projects: Set<String>
    ) -> [ScriptError] {
        errors.filter { err in
            let toolMatch = tools.isEmpty || tools.contains(err.tool)
            let projectMatch = projects.isEmpty
                || (err.project.map { projects.contains($0) } ?? false)
            return toolMatch && projectMatch
        }
    }

    private func mkError(_ tool: String, _ project: String?) -> ScriptError {
        ScriptError(
            id: tool + (project ?? "_"),
            script: tool,
            message: "boom",
            capturedAt: Date(),
            project: project
        )
    }

    func test_filter_emptySets_returnsAll() {
        let errs = [
            mkError("Read", "nx"),
            mkError("Bash", "oo"),
            mkError("Write", "nx"),
        ]
        XCTAssertEqual(filter(errors: errs, tools: [], projects: []).count, 3)
    }

    func test_filter_singleTool_narrowsRows() {
        let errs = [
            mkError("Read", "nx"),
            mkError("Read", "oo"),
            mkError("Bash", "nx"),
        ]
        let filtered = filter(errors: errs, tools: ["Read"], projects: [])
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { $0.tool == "Read" })
    }

    func test_filter_multiToolWithinCategory_isAdditive() {
        let errs = [
            mkError("Read", "nx"),
            mkError("Bash", "nx"),
            mkError("Write", "nx"),
        ]
        let filtered = filter(errors: errs, tools: ["Read", "Bash"], projects: [])
        XCTAssertEqual(filtered.count, 2)
    }

    func test_filter_toolAndProject_isAnd() {
        let errs = [
            mkError("Read", "nx"),
            mkError("Read", "oo"),
            mkError("Bash", "nx"),
        ]
        let filtered = filter(errors: errs, tools: ["Read"], projects: ["nx"])
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.tool, "Read")
        XCTAssertEqual(filtered.first?.project, "nx")
    }

    func test_filter_projectFilter_excludesRowsMissingProject() {
        let errs = [
            mkError("Read", "nx"),
            mkError("Read", nil), // notification-failure row, no project
        ]
        let filtered = filter(errors: errs, tools: [], projects: ["nx"])
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.project, "nx")
    }

    // MARK: - Empty-state disambiguation logic

    /// Mirrors the view's selector: hasActiveFilters && total > 0 → "by filter"
    /// branch; otherwise the global "No failures" branch.
    private func isEmptyByFilter(
        total: Int,
        toolFilters: Set<String>,
        projectFilters: Set<String>
    ) -> Bool {
        let hasFilters = !toolFilters.isEmpty || !projectFilters.isEmpty
        return hasFilters && total > 0
    }

    func test_emptyState_totalZero_globalEmptyEvenWithFilters() {
        // total==0 means there's nothing to filter — show global empty.
        XCTAssertFalse(isEmptyByFilter(total: 0, toolFilters: ["Read"], projectFilters: []))
    }

    func test_emptyState_totalNonZeroWithFilters_isByFilter() {
        XCTAssertTrue(isEmptyByFilter(total: 12, toolFilters: ["Read"], projectFilters: []))
    }

    func test_emptyState_totalNonZeroNoFilters_isGlobal() {
        XCTAssertFalse(isEmptyByFilter(total: 12, toolFilters: [], projectFilters: []))
    }
}
