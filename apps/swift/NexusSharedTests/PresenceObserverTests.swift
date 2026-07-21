// PresenceObserverTests — exercise the pure presence decision logic without
// live hardware (mac-presence-observer, nx-41qha).
//
// The live macOS listeners (CMIO / CoreAudio / DistNote) need a real Aqua
// session, so they are NOT tested here. Instead the decision logic is factored
// into the hardware-free `PresenceSensing` enum + `RawSignals` struct, and
// these tests cover the spec-critical branches:
//   • meeting AND-gate: camera-alone → NOT inMeeting; camera+running-meeting-app
//     → inMeeting (the app need only be running, not frontmost —
//     meeting-detection-running-app-gate)
//   • delta emission on lock / idle change
//   • Focus-DB parse fail-open (malformed JSON → nil, no crash)

import XCTest
@testable import NexusShared

final class PresenceObserverTests: XCTestCase {

    // MARK: - Meeting AND-gate (Q2)

    func testCameraAloneIsNotMeeting() {
        // Camera in use but the only running app is Photo Booth (NOT a meeting app).
        let s = RawSignals(
            cameraInUse: true,
            runningBundleIds: ["com.apple.PhotoBooth"]
        )
        XCTAssertFalse(PresenceSensing.isMeeting(s),
                       "camera-alone with a non-meeting app must not be a meeting")
    }

    func testCameraWithNoRunningMeetingAppIsNotMeeting() {
        // Camera in use but no meeting app is running at all.
        let s = RawSignals(cameraInUse: true, runningBundleIds: [])
        XCTAssertFalse(PresenceSensing.isMeeting(s))
    }

    func testCameraPlusRunningMeetingAppIsMeeting() {
        let s = RawSignals(
            cameraInUse: true,
            runningBundleIds: ["us.zoom.xos"]
        )
        XCTAssertTrue(PresenceSensing.isMeeting(s),
                      "camera + a running meeting app is a meeting")
    }

    func testMicPlusRunningMeetingAppIsMeeting() {
        // Audio-only call (mic on, no camera) with Teams running still counts.
        let s = RawSignals(
            micInUse: true,
            runningBundleIds: ["com.microsoft.teams2"]
        )
        XCTAssertTrue(PresenceSensing.isMeeting(s))
    }

    func testMeetingAppRunningNotFrontmostIsStillMeeting() {
        // Zoom is one of several running apps (Terminal is the frontmost one the
        // user alt-tabbed to), camera still live → this MUST remain a meeting.
        // This is the exact workflow meeting-detection-running-app-gate protects.
        let s = RawSignals(
            cameraInUse: true,
            runningBundleIds: ["us.zoom.xos", "com.apple.Terminal", "com.tinyspeck.slackmacgap"]
        )
        XCTAssertTrue(PresenceSensing.isMeeting(s),
                      "a running meeting app need not be frontmost to count as a meeting")
    }

    func testMeetingAppNotRunningWithCameraIsNotMeeting() {
        // Camera in use, several non-meeting apps running, but no meeting app
        // is running at all → not a meeting even with a live capture device.
        let s = RawSignals(
            cameraInUse: true,
            runningBundleIds: ["com.apple.Terminal", "com.apple.dt.Xcode"]
        )
        XCTAssertFalse(PresenceSensing.isMeeting(s),
                       "camera in use but no meeting app running is not a meeting")
    }

    func testMeetingAppRunningButIdleIsNotMeeting() {
        // Zoom open (running) but neither camera nor mic running — the
        // camera-alone guarantee, phrased as "meeting app open but idle".
        let s = RawSignals(runningBundleIds: ["us.zoom.xos"])
        XCTAssertFalse(PresenceSensing.isMeeting(s),
                       "a running meeting app with no capture device is not a live meeting")
    }

    // MARK: - Active gate

    func testActiveRequiresConsoleUnlockedAndNotIdle() {
        XCTAssertTrue(PresenceSensing.isActive(
            RawSignals(idleSeconds: 5, screenLocked: false, onConsole: true)))
        // Locked → not active.
        XCTAssertFalse(PresenceSensing.isActive(
            RawSignals(idleSeconds: 5, screenLocked: true, onConsole: true)))
        // Idle past threshold → not active.
        XCTAssertFalse(PresenceSensing.isActive(
            RawSignals(idleSeconds: 120, screenLocked: false, onConsole: true)))
        // Off-console (fast-user-switched away) → not active.
        XCTAssertFalse(PresenceSensing.isActive(
            RawSignals(idleSeconds: 5, screenLocked: false, onConsole: false)))
    }

    // MARK: - Delta emission

    func testFirstDeltaStampsHostAndFullState() {
        let s = RawSignals(idleSeconds: 3, screenLocked: false, onConsole: true)
        let d = PresenceSensing.delta(from: nil, to: s, host: "macbook", isFirst: true)
        XCTAssertEqual(d.macHost, "macbook")
        XCTAssertEqual(d.macActive, true)
        XCTAssertEqual(d.macLocked, false)
        XCTAssertEqual(d.inMeeting, false)
        XCTAssertFalse(d.isEmpty)
    }

    func testLockTransitionEmitsLockedDelta() {
        let unlocked = RawSignals(idleSeconds: 3, screenLocked: false, onConsole: true)
        let locked = RawSignals(idleSeconds: 3, screenLocked: true, onConsole: true)
        let d = PresenceSensing.delta(from: unlocked, to: locked, host: "h", isFirst: false)
        XCTAssertEqual(d.macLocked, true, "lock change must emit macLocked")
        // Locking also flips active false (screenLocked gates isActive).
        XCTAssertEqual(d.macActive, false)
        XCTAssertNil(d.macHost, "host is only stamped on the first delta")
    }

    func testIdleCrossingThresholdEmitsActiveChange() {
        let active = RawSignals(idleSeconds: 10, screenLocked: false, onConsole: true)
        let idle = RawSignals(idleSeconds: 90, screenLocked: false, onConsole: true)
        let d = PresenceSensing.delta(from: active, to: idle, host: "h", isFirst: false)
        XCTAssertEqual(d.macActive, false, "crossing the idle threshold flips macActive")
        XCTAssertEqual(d.macIdleSec, 90)
    }

    func testNoChangeEmitsEmptyDelta() {
        let s = RawSignals(idleSeconds: 5, screenLocked: false, onConsole: true)
        // Same coalesced idle second, same everything → empty delta.
        let same = RawSignals(idleSeconds: 5, screenLocked: false, onConsole: true)
        let d = PresenceSensing.delta(from: s, to: same, host: "h", isFirst: false)
        XCTAssertTrue(d.isEmpty, "an unchanged snapshot must produce an empty delta")
    }

    func testMeetingTransitionEmitsInMeeting() {
        // Zoom already running, camera comes on → the delta reports inMeeting: true.
        let pre = RawSignals(runningBundleIds: ["us.zoom.xos"])
        let inCall = RawSignals(cameraInUse: true, runningBundleIds: ["us.zoom.xos"])
        let d = PresenceSensing.delta(from: pre, to: inCall, host: "h", isFirst: false)
        XCTAssertEqual(d.inMeeting, true)
    }

    func testMeetingEndsWhenAppQuitsEmitsInMeetingFalse() {
        // In a call (camera live, Zoom running) → Zoom quits (leaves the running
        // set) while the camera is still live → the next delta flips inMeeting false.
        let inCall = RawSignals(cameraInUse: true, runningBundleIds: ["us.zoom.xos", "com.apple.Terminal"])
        let appQuit = RawSignals(cameraInUse: true, runningBundleIds: ["com.apple.Terminal"])
        let d = PresenceSensing.delta(from: inCall, to: appQuit, host: "h", isFirst: false)
        XCTAssertEqual(d.inMeeting, false,
                       "quitting the meeting app ends the meeting on the next delta")
    }

    func testMeetingEndsWhenDevicesGoIdleEmitsInMeetingFalse() {
        // In a call → both camera and mic stop while Zoom stays running → the
        // next delta flips inMeeting false.
        let inCall = RawSignals(cameraInUse: true, micInUse: true, runningBundleIds: ["us.zoom.xos"])
        let idle = RawSignals(cameraInUse: false, micInUse: false, runningBundleIds: ["us.zoom.xos"])
        let d = PresenceSensing.delta(from: inCall, to: idle, host: "h", isFirst: false)
        XCTAssertEqual(d.inMeeting, false,
                       "camera and mic both going idle ends the meeting on the next delta")
    }

    func testFocusModeChangeEmitsMacFocus() {
        let none = RawSignals(focusMode: nil)
        let work = RawSignals(focusMode: "com.apple.focus.work")
        let d = PresenceSensing.delta(from: none, to: work, host: "h", isFirst: false)
        // Double-optional: outer .some (changed), inner the new mode.
        XCTAssertEqual(d.macFocus ?? nil, "com.apple.focus.work")
    }

    // MARK: - Focus-DB fail-open

    func testMalformedFocusDBFailsOpen() {
        let garbage = Data("this is not json {".utf8)
        XCTAssertNil(PresenceSensing.parseFocusMode(fromDB: garbage),
                     "malformed Focus DB must fail-open to nil, not crash")
    }

    func testEmptyFocusDBFailsOpen() {
        XCTAssertNil(PresenceSensing.parseFocusMode(fromDB: Data()))
    }

    func testTopLevelArrayFocusDBFailsOpen() {
        // A JSON array (not the expected object) → unknown.
        let arr = Data("[1,2,3]".utf8)
        XCTAssertNil(PresenceSensing.parseFocusMode(fromDB: arr))
    }

    func testNoActiveAssertionReadsNoFocus() {
        let json = Data(#"{"data":[{"storeAssertionRecords":[]}]}"#.utf8)
        XCTAssertNil(PresenceSensing.parseFocusMode(fromDB: json),
                     "no assertion records means no active Focus")
    }

    func testActiveFocusAssertionParses() {
        let json = Data(#"""
        {"data":[{"storeAssertionRecords":[{"assertionDetails":{"assertionDetailsModeIdentifier":"com.apple.focus.work"}}]}]}
        """#.utf8)
        XCTAssertEqual(
            PresenceSensing.parseFocusMode(fromDB: json),
            "com.apple.focus.work"
        )
    }

    // MARK: - Wire body

    func testWireBodySerializesNonNilSubset() {
        var d = PresenceDelta()
        d.macActive = true
        d.macLocked = false
        d.macHost = "macbook"
        d.macIdleSec = 12
        let body = d.wireBody()
        XCTAssertEqual(body["macActive"] as? Bool, true)
        XCTAssertEqual(body["macLocked"] as? Bool, false)
        XCTAssertEqual(body["macHost"] as? String, "macbook")
        XCTAssertEqual(body["macIdleSec"] as? Double, 12)
        // inMeeting / macFocus / homeHint were never set → absent from the body.
        XCTAssertNil(body["inMeeting"])
        XCTAssertNil(body["macFocus"])
        XCTAssertNil(body["homeHint"])
    }

    func testWireBodyClearedFocusSerializesNull() {
        var d = PresenceDelta()
        d.macFocus = .some(nil)  // explicit "Focus cleared"
        let body = d.wireBody()
        XCTAssertTrue(body["macFocus"] is NSNull,
                      "a cleared Focus serializes as JSON null (agent accepts string|null)")
    }

    // MARK: - ARP MAC parsing (gateway-MAC fingerprint)

    func testParseMACFromARPLine() {
        let line = "? (192.168.1.1) at a4:b1:c1:d2:e3:f4 on en0 ifscope [ethernet]"
        XCTAssertEqual(
            PresenceObserver.parseMAC(fromARP: line),
            "a4:b1:c1:d2:e3:f4"
        )
    }

    func testParseMACNormalisesSingleDigitOctets() {
        // BSD arp may print octets without a leading zero (e.g. `4` for `04`).
        let line = "? (10.0.0.1) at 4:b:c1:2:e3:f on en0"
        XCTAssertEqual(
            PresenceObserver.parseMAC(fromARP: line),
            "04:0b:c1:02:e3:0f"
        )
    }

    func testParseMACIncompleteReturnsEmpty() {
        let line = "? (10.0.0.9) at (incomplete) on en0"
        XCTAssertEqual(PresenceObserver.parseMAC(fromARP: line), "")
    }
}
