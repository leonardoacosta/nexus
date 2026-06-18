// NotificationDisplayTitleTests — pin NotificationEvent.displayTitle to the
// agent's composeTitle(project, session, fallback) rule (notification-fidelity
// task 3.1). Keeps the Swift display ladder in lockstep with the bun unit test
// in API batch task 1.3 (apps/agent/src/health-push/notification-push.ts).
//
// Rule under test:
//   project && session -> "project · session" (MIDDOT U+00B7, spaces around)
//   else session
//   else project
//   else title
//   else "Nexus"
// Empty / whitespace-only inputs are treated as absent.

import XCTest
@testable import NexusShared

final class NotificationDisplayTitleTests: XCTestCase {

    /// Both present -> "project · session" with the MIDDOT separator.
    func testBothPresentComposesProjectMiddotSession() {
        let n = NotificationEvent(
            body: "Login flow fixed",
            title: "ignored when both present",
            project: "oo",
            sessionName: "fix-login-flow"
        )
        XCTAssertEqual(n.displayTitle, "oo · fix-login-flow")
    }

    /// Session-only -> session.
    func testSessionOnlyFallsBackToSession() {
        let n = NotificationEvent(
            body: "x",
            title: "ignored",
            project: nil,
            sessionName: "fix-login-flow"
        )
        XCTAssertEqual(n.displayTitle, "fix-login-flow")
    }

    /// Project-only -> project.
    func testProjectOnlyFallsBackToProject() {
        let n = NotificationEvent(
            body: "x",
            title: "ignored",
            project: "oo",
            sessionName: nil
        )
        XCTAssertEqual(n.displayTitle, "oo")
    }

    /// Neither project nor session -> title.
    func testNeitherFallsBackToTitle() {
        let n = NotificationEvent(
            body: "x",
            title: "Weekly reaper done",
            project: nil,
            sessionName: nil
        )
        XCTAssertEqual(n.displayTitle, "Weekly reaper done")
    }

    /// Neither project, session, nor title -> "Nexus".
    func testEmptyEverythingFallsBackToNexus() {
        let n = NotificationEvent(
            body: "x",
            title: nil,
            project: nil,
            sessionName: nil
        )
        XCTAssertEqual(n.displayTitle, "Nexus")
    }

    /// Whitespace-only inputs are treated as absent (matches composeTitle's
    /// trim-and-test rule). Both whitespace -> falls through to title.
    func testWhitespaceOnlyTreatedAsAbsent() {
        let n = NotificationEvent(
            body: "x",
            title: "Real title",
            project: "   ",
            sessionName: "\t\n"
        )
        XCTAssertEqual(n.displayTitle, "Real title")
    }
}
