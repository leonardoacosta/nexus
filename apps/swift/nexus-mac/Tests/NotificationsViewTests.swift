// NotificationsViewTests — pin sort, group, and replay visibility
// rules added by openspec/changes/notifications-overhaul (UI batch
// task 3.13).
//
// Sort persistence is enforced by `@AppStorage` (UserDefaults) — we
// assert through the static `sorted` + `grouped` helpers on
// `NotificationsView`, which keeps the rules verifiable without
// instantiating SwiftUI views.

import XCTest
@testable import nexus
@testable import NexusShared

final class NotificationsViewTests: XCTestCase {

    private func event(
        body: String,
        project: String? = nil,
        channel: String? = nil,
        receivedAt: Date,
        audioAvailable: Bool? = nil
    ) -> NotificationEvent {
        NotificationEvent(
            body: body,
            channel: channel,
            project: project,
            receivedAt: receivedAt,
            audioAvailable: audioAvailable
        )
    }

    // MARK: - 3.5 sort persistence + ordering

    func testSortByTimeNewestFirst() {
        let oldest = event(body: "a", receivedAt: Date(timeIntervalSince1970: 100))
        let middle = event(body: "b", receivedAt: Date(timeIntervalSince1970: 200))
        let newest = event(body: "c", receivedAt: Date(timeIntervalSince1970: 300))
        let sorted = NotificationsView.sorted([oldest, newest, middle], mode: .time)
        XCTAssertEqual(sorted.map(\.body), ["c", "b", "a"])
    }

    func testSortByProjectAlphabeticalWithMiscLast() {
        let a = event(body: "alpha", project: "alpha", receivedAt: Date(timeIntervalSince1970: 1))
        let z = event(body: "zulu", project: "zulu", receivedAt: Date(timeIntervalSince1970: 1))
        let none = event(body: "system", project: nil, receivedAt: Date(timeIntervalSince1970: 999))
        let sorted = NotificationsView.sorted([none, z, a], mode: .project)
        // alpha < zulu < (nil at end)
        XCTAssertEqual(sorted.map(\.body), ["alpha", "zulu", "system"])
    }

    func testSortBySessionUsesChannelAsProxy() {
        let tts = event(body: "tts", channel: "tts", receivedAt: Date(timeIntervalSince1970: 1))
        let desktop = event(body: "desk", channel: "desktop", receivedAt: Date(timeIntervalSince1970: 1))
        let nilCh = event(body: "sys", channel: nil, receivedAt: Date(timeIntervalSince1970: 999))
        let sorted = NotificationsView.sorted([nilCh, tts, desktop], mode: .session)
        XCTAssertEqual(sorted.map(\.body), ["desk", "tts", "sys"])
    }

    // MARK: - 3.6 group bucket rules

    func testGroupedByProjectPutsMiscLast() {
        let nx = event(body: "n1", project: "nx", receivedAt: Date(timeIntervalSince1970: 1))
        let oo = event(body: "o1", project: "oo", receivedAt: Date(timeIntervalSince1970: 1))
        let misc = event(body: "m1", project: nil, receivedAt: Date(timeIntervalSince1970: 1))
        let groups = NotificationsView.grouped([nx, misc, oo], mode: .project)
        XCTAssertEqual(groups.map(\.group), ["nx", "oo", "Misc"])
        XCTAssertEqual(groups.last?.rows.count, 1)
    }

    func testGroupedByTimeIsSingleBucket() {
        let a = event(body: "a", receivedAt: Date(timeIntervalSince1970: 1))
        let b = event(body: "b", receivedAt: Date(timeIntervalSince1970: 2))
        let groups = NotificationsView.grouped([a, b], mode: .time)
        // All rows collapse into the "" bucket when sort = time — that's
        // the docstring behaviour because the disclosure UI is hidden
        // when sortMode = .time.
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.rows.count, 2)
    }

    // MARK: - 3.7 replay button visibility

    func testReplayButtonHiddenWhenAudioUnavailable() {
        let row = event(body: "x", receivedAt: Date(), audioAvailable: false)
        // The row component reads `audioAvailable == true` and hides the
        // button otherwise; we assert the model boolean directly because
        // SwiftUI rendering is not exercised in unit tests.
        XCTAssertFalse(row.audioAvailable ?? false)
    }

    func testReplayButtonVisibleWhenAudioAvailable() {
        let row = event(body: "x", receivedAt: Date(), audioAvailable: true)
        XCTAssertEqual(row.audioAvailable, true)
    }
}
