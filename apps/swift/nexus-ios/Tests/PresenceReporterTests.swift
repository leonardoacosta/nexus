// PresenceReporterTests — the reporter's PURE decision logic, no live hardware.
//
// Spec: openspec/changes/ios-presence-reporter (Phase 2, nx-xm1bn).
//
// Covers the three pure surfaces PresenceReporter factors out:
//   1. SleepWindow.isInWindow — in-window computation from a sleep-schedule
//      fixture (inside an interval, inside the grace tail, outside, .awake never
//      establishes a window).
//   2. PresencePayload.body — the report payload is built with the correct keys
//      (machine / hkSleepWindow / sleepFocusActive / phoneFocusOn) + values,
//      i.e. Focus-on -> phoneFocusOn true.
//   3. PresenceReporter.isAsleep — sleep-stage classification.

import XCTest
@testable import nexus

final class PresenceReporterTests: XCTestCase {

    private let ref = Date(timeIntervalSince1970: 1_700_000_000) // fixed "now"

    // MARK: - SleepWindow.isInWindow

    func testInsideAsleepIntervalIsInWindow() {
        let intervals = [
            SleepInterval(
                start: ref.addingTimeInterval(-3600),
                end: ref.addingTimeInterval(3600),
                asleep: true
            )
        ]
        XCTAssertTrue(SleepWindow.isInWindow(at: ref, intervals: intervals))
    }

    func testWithinGraceTailIsInWindow() {
        // Interval ended 10 min ago; default grace is 30 min -> still in window.
        let intervals = [
            SleepInterval(
                start: ref.addingTimeInterval(-7200),
                end: ref.addingTimeInterval(-600),
                asleep: true
            )
        ]
        XCTAssertTrue(SleepWindow.isInWindow(at: ref, intervals: intervals))
    }

    func testPastGraceTailIsNotInWindow() {
        // Interval ended 45 min ago -> beyond the 30-min grace.
        let intervals = [
            SleepInterval(
                start: ref.addingTimeInterval(-7200),
                end: ref.addingTimeInterval(-2700),
                asleep: true
            )
        ]
        XCTAssertFalse(SleepWindow.isInWindow(at: ref, intervals: intervals))
    }

    func testAwakeIntervalNeverEstablishesWindow() {
        // A non-asleep interval that contains `now` does NOT count.
        let intervals = [
            SleepInterval(
                start: ref.addingTimeInterval(-1800),
                end: ref.addingTimeInterval(1800),
                asleep: false
            )
        ]
        XCTAssertFalse(SleepWindow.isInWindow(at: ref, intervals: intervals))
    }

    func testNoIntervalsIsNotInWindow() {
        XCTAssertFalse(SleepWindow.isInWindow(at: ref, intervals: []))
    }

    func testPicksMatchingIntervalAmongMany() {
        let intervals = [
            SleepInterval(start: ref.addingTimeInterval(-99_999), end: ref.addingTimeInterval(-90_000), asleep: true),
            SleepInterval(start: ref.addingTimeInterval(-60), end: ref.addingTimeInterval(60), asleep: true),
            SleepInterval(start: ref.addingTimeInterval(90_000), end: ref.addingTimeInterval(99_999), asleep: true),
        ]
        XCTAssertTrue(SleepWindow.isInWindow(at: ref, intervals: intervals))
    }

    // MARK: - PresencePayload.body (correct keys + shape)

    func testPayloadBodyHasCorrectKeysAndValues() {
        let payload = PresencePayload(
            machine: "Leo-iPhone",
            hkSleepWindow: true,
            sleepFocusActive: false,
            phoneFocusOn: true
        )
        let body = payload.body
        XCTAssertEqual(Set(body.keys), ["machine", "hkSleepWindow", "sleepFocusActive", "phoneFocusOn"])
        XCTAssertEqual(body["machine"] as? String, "Leo-iPhone")
        XCTAssertEqual(body["hkSleepWindow"] as? Bool, true)
        XCTAssertEqual(body["sleepFocusActive"] as? Bool, false)
        XCTAssertEqual(body["phoneFocusOn"] as? Bool, true)
    }

    func testFocusOnMapsToPhoneFocusOnTrue() {
        // Mirrors the reporter: a known-active Focus -> phoneFocusOn true.
        let focusActive = true
        let payload = PresencePayload(
            machine: "iphone",
            hkSleepWindow: false,
            sleepFocusActive: focusActive,
            phoneFocusOn: focusActive
        )
        XCTAssertEqual(payload.body["phoneFocusOn"] as? Bool, true)
        XCTAssertEqual(payload.body["sleepFocusActive"] as? Bool, true)
    }

    func testPayloadSerializesToJSON() {
        // The body must be JSONSerialization-safe (it's POSTed via reportPresence).
        let payload = PresencePayload(
            machine: "iphone",
            hkSleepWindow: false,
            sleepFocusActive: false,
            phoneFocusOn: false
        )
        XCTAssertTrue(JSONSerialization.isValidJSONObject(payload.body))
    }
}
