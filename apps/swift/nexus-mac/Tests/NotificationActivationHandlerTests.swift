// NotificationActivationHandlerTests — host-bundled coverage for the
// AppKit-bound delegate that closes the loop on
// `NSWorkspace.shared.open(_:)` when a banner click carries a
// `nexus.logPath` userInfo entry.
//
// Spec: openspec/changes/adopt-reaper-into-nx-cron task 3.4. The
// cross-platform extractor (`NotificationActivation.target(from:)`) is
// covered in `NexusSharedTests/ReaperNotificationTests.swift`. This file
// asserts the AppKit-bound seam invokes the injected file opener exactly
// when the extractor's contract says it should.
//
// Why host-bundled
// ────────────────
// `NotificationActivationHandler` initializes `NSWorkspace.shared` via
// the default `init()`. NSWorkspace requires an app context to resolve;
// without TEST_HOST (the case for NexusSharedTests) the symbol resolves
// but invocation crashes the test process. nexus-mac-Tests has
// `TEST_HOST = nexus.app` per project.yml, so AppKit calls are safe here.

import XCTest
@testable import NexusShared
// `nexus` is the PRODUCT_NAME of the nexus-mac target (see project.yml).
// The host app supplies `NotificationActivationHandler`; tests reach in
// via `@testable` so the type's internal seam stays visible.
@testable import nexus

final class NotificationActivationHandlerTests: XCTestCase {

    // MARK: - Test harness

    /// Recording opener — captures every URL the handler routes through
    /// `NSWorkspace.shared.open(_:)`. Pre-fix the handler used a raw
    /// osascript dispatch which mis-attributed click source; the harness
    /// shape mirrors the AppKit `.open(_:) -> Bool` contract.
    private final class RecordingOpener {
        private(set) var opened: [URL] = []
        var nextResult: Bool = true

        func open(_ url: URL) -> Bool {
            opened.append(url)
            return nextResult
        }
    }

    // MARK: - 3.4 — bullet rendering smoke (delegate doesn't render; it
    // routes activation, so the assertion is on routing behaviour).

    /// Non-empty logPath userInfo → opener invoked with the expected URL.
    func testActivateRoutesNonEmptyLogPathThroughOpener() {
        let recorder = RecordingOpener()
        let handler = NotificationActivationHandler { url in
            recorder.open(url)
        }

        let path = "/Users/leonardoacosta/.local/share/nexus/reaper/2026-05-21.log"
        handler.activate(userInfo: [
            NotificationUserInfoKeys.logPath: path
        ])

        XCTAssertEqual(recorder.opened.count, 1, "opener invoked exactly once")
        XCTAssertEqual(
            recorder.opened.first,
            URL(fileURLWithPath: path),
            "opener receives URL(fileURLWithPath:) for the userInfo path"
        )
    }

    /// Absent logPath → opener NOT invoked (default activation
    /// preserves pre-fix behaviour for every non-reaper notification).
    func testActivateNoLogPathLeavesOpenerUntouched() {
        let recorder = RecordingOpener()
        let handler = NotificationActivationHandler { url in
            recorder.open(url)
        }

        handler.activate(userInfo: [:])

        XCTAssertTrue(
            recorder.opened.isEmpty,
            "default activation path MUST NOT route through file opener"
        )
    }

    /// Empty-string logPath → opener NOT invoked (treated as absent).
    func testActivateEmptyLogPathLeavesOpenerUntouched() {
        let recorder = RecordingOpener()
        let handler = NotificationActivationHandler { url in
            recorder.open(url)
        }

        handler.activate(userInfo: [
            NotificationUserInfoKeys.logPath: ""
        ])

        XCTAssertTrue(
            recorder.opened.isEmpty,
            "empty logPath collapses to default activation"
        )
    }

    /// Opener returning `false` (NSWorkspace failed to resolve a handler)
    /// is logged but does not crash — handler swallows the failed open.
    func testActivateToleratesOpenerFailure() {
        let recorder = RecordingOpener()
        recorder.nextResult = false
        let handler = NotificationActivationHandler { url in
            recorder.open(url)
        }

        // Should NOT throw or trap on opener failure.
        handler.activate(userInfo: [
            NotificationUserInfoKeys.logPath: "/nonexistent/path.log"
        ])

        XCTAssertEqual(recorder.opened.count, 1, "opener still invoked")
    }
}
