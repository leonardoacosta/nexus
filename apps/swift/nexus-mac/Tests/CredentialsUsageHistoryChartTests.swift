// CredentialsUsageHistoryChartTests — utilization mapping + empty-hide.
//
// Spec: openspec/changes/credential-usage-history (task 4.4) — bd:nx-2w15v

import XCTest
import NexusShared
@testable import nexus

final class CredentialsUsageHistoryChartTests: XCTestCase {
    private func point(used: Int, limit: Int, at offset: TimeInterval = 0)
        -> UsageHistoryPoint
    {
        UsageHistoryPoint(
            polledAt: Date(timeIntervalSince1970: 1_700_000_000 + offset),
            used: used,
            limit: limit
        )
    }

    // MARK: - points -> utilization ratio

    func test_ratios_mapEachPointToUtilization() {
        let chart = CredentialsUsageHistoryChart(
            points: [
                point(used: 100, limit: 800, at: 0),   // 0.125
                point(used: 400, limit: 800, at: 300),  // 0.5
                point(used: 800, limit: 800, at: 600),  // 1.0
            ],
            label: "5h"
        )
        let ratios = chart.ratios.map(\.ratio)
        XCTAssertEqual(ratios.count, 3)
        XCTAssertEqual(ratios[0], 0.125, accuracy: 0.0001)
        XCTAssertEqual(ratios[1], 0.5, accuracy: 0.0001)
        XCTAssertEqual(ratios[2], 1.0, accuracy: 0.0001)
    }

    func test_ratio_zeroLimit_isZero() throws {
        let chart = CredentialsUsageHistoryChart(
            points: [point(used: 99, limit: 0)],
            label: "5h"
        )
        let ratio = try XCTUnwrap(chart.ratios.first?.ratio)
        XCTAssertEqual(ratio, 0, accuracy: 0.0001)
    }

    func test_ratio_overLimit_clampsToOne() throws {
        let chart = CredentialsUsageHistoryChart(
            points: [point(used: 2000, limit: 800)],
            label: "5h"
        )
        let ratio = try XCTUnwrap(chart.ratios.first?.ratio)
        XCTAssertEqual(ratio, 1.0, accuracy: 0.0001)
    }

    func test_ratios_preserveChronologicalOrder() {
        let chart = CredentialsUsageHistoryChart(
            points: [
                point(used: 100, limit: 800, at: 0),
                point(used: 200, limit: 800, at: 300),
            ],
            label: "5h"
        )
        XCTAssertLessThan(chart.ratios[0].date, chart.ratios[1].date)
    }

    // MARK: - empty points hides the chart

    func test_emptyPoints_hasNoData() {
        let chart = CredentialsUsageHistoryChart(points: [], label: "5h")
        XCTAssertFalse(chart.hasData)
    }

    func test_nonEmptyPoints_hasData() {
        let chart = CredentialsUsageHistoryChart(
            points: [point(used: 100, limit: 800)],
            label: "5h"
        )
        XCTAssertTrue(chart.hasData)
    }
}
