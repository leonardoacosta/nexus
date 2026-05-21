// CredentialsUsageBarTests — color thresholds + countdown formatting.
//
// Spec: credentials-account-resolve-and-usage (task 3.8)

import XCTest
import SwiftUI
@testable import nexus

final class CredentialsUsageBarTests: XCTestCase {
    // MARK: - Color thresholds

    func test_utilization_belowWarn_isGreen() {
        let bar = CredentialsUsageBar(
            used: 10,
            limit: 50,
            resetAt: nil,
            label: "5h"
        )
        XCTAssertEqual(bar.utilization, 0.2, accuracy: 0.0001)
        XCTAssertEqual(bar.fillColor, Color.green)
    }

    func test_utilization_atWarnThreshold_isYellow() {
        let bar = CredentialsUsageBar(
            used: 35,
            limit: 50,
            resetAt: nil,
            label: "5h"
        )
        XCTAssertEqual(bar.utilization, 0.7, accuracy: 0.0001)
        XCTAssertEqual(bar.fillColor, Color.yellow)
    }

    func test_utilization_atCriticalThreshold_isRed() {
        let bar = CredentialsUsageBar(
            used: 45,
            limit: 50,
            resetAt: nil,
            label: "5h"
        )
        XCTAssertEqual(bar.utilization, 0.9, accuracy: 0.0001)
        XCTAssertEqual(bar.fillColor, Color.red)
    }

    func test_utilization_aboveLimit_clamps() {
        let bar = CredentialsUsageBar(
            used: 200,
            limit: 50,
            resetAt: nil,
            label: "5h"
        )
        XCTAssertEqual(bar.utilization, 1.0, accuracy: 0.0001)
        XCTAssertEqual(bar.fillColor, Color.red)
    }

    func test_utilization_withZeroLimit_returnsZero() {
        let bar = CredentialsUsageBar(
            used: 99,
            limit: 0,
            resetAt: nil,
            label: "5h"
        )
        XCTAssertEqual(bar.utilization, 0.0, accuracy: 0.0001)
        XCTAssertEqual(bar.fillColor, Color.green)
    }

    // MARK: - Countdown formatting

    func test_countdown_overOneHour_formatsHoursAndMinutes() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        // 2h 14m 30s ahead.
        let target = now.addingTimeInterval(2 * 3600 + 14 * 60 + 30)
        let text = CredentialsUsageBar.formatCountdown(to: target, now: now)
        XCTAssertEqual(text, "Resets in 2h 14m")
    }

    func test_countdown_underOneHour_formatsMinutesOnly() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        // 45m 12s ahead.
        let target = now.addingTimeInterval(45 * 60 + 12)
        let text = CredentialsUsageBar.formatCountdown(to: target, now: now)
        XCTAssertEqual(text, "Resets in 45m")
    }

    func test_countdown_pastDue_returnsResetDue() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let target = now.addingTimeInterval(-60)
        let text = CredentialsUsageBar.formatCountdown(to: target, now: now)
        XCTAssertEqual(text, "Reset due")
    }
}
