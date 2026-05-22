// SettingsDiagnosticsViewTests — traffic-light thresholds, copy-with-
// confirmation flow (Cancel must NOT write to pasteboard), plain-text
// payload format.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.14, bd:nx-dlazx)

import XCTest
@testable import nexus
@testable import NexusShared

@MainActor
final class SettingsDiagnosticsViewTests: XCTestCase {

    // MARK: - Traffic-light thresholds

    func testTrafficLightGreenUnder30s() {
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 0), .green)
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 12), .green)
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 29.9), .green)
    }

    func testTrafficLightYellow30To120s() {
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 30), .yellow)
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 90), .yellow)
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 119), .yellow)
    }

    func testTrafficLightRedOver2min() {
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 120), .red)
        XCTAssertEqual(StalenessIndicator.bucket(ageSeconds: 600), .red)
    }

    // MARK: - Copy-with-confirmation

    func testCopyCancelDoesNotWriteToPasteboard() {
        let model = SettingsDiagnosticsViewModel()
        var writes: [String] = []
        model.pasteboardWriter = { writes.append($0) }
        model.requestCopy()
        XCTAssertTrue(model.showingCopyConfirmation)
        XCTAssertFalse(model.pendingPayload.isEmpty)

        // User cancels.
        model.cancelCopy()
        XCTAssertFalse(model.showingCopyConfirmation)
        XCTAssertTrue(writes.isEmpty, "Cancel MUST NOT write to clipboard")
    }

    func testCopyConfirmWritesStagedPayload() {
        let model = SettingsDiagnosticsViewModel()
        var writes: [String] = []
        model.pasteboardWriter = { writes.append($0) }
        model.requestCopy()
        let staged = model.pendingPayload
        model.confirmCopy()
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first, staged)
        XCTAssertFalse(model.showingCopyConfirmation)
    }

    // MARK: - Payload format

    func testPayloadStartsWithDateHeader() {
        let model = SettingsDiagnosticsViewModel()
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let payload = model.buildPayload(now: now)
        XCTAssertTrue(payload.hasPrefix("nexus diagnostics — "))
        XCTAssertTrue(payload.contains("last_snapshot"))
        XCTAssertTrue(payload.contains("last_watcher_tick"))
        XCTAssertTrue(payload.contains("socket_listening"))
        XCTAssertTrue(payload.contains("db_ok"))
        XCTAssertTrue(payload.contains("agents_count"))
        XCTAssertTrue(payload.contains("dashboard_sha"))
        XCTAssertTrue(payload.contains("agent_sha"))
    }

    func testAgeFormatterCovers3Tiers() {
        XCTAssertEqual(SettingsDiagnosticsViewModel.formatAge(5), "5s ago")
        XCTAssertEqual(SettingsDiagnosticsViewModel.formatAge(125), "2m 5s ago")
        XCTAssertEqual(SettingsDiagnosticsViewModel.formatAge(3_700), "1h 1m ago")
    }
}
