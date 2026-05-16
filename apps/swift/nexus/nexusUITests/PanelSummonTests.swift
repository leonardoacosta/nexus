//
//  PanelSummonTests.swift
//  nexusUITests
//
//  Launches the app headlessly and verifies it survives launch. UI tests
//  can't directly synthesize a system global hotkey, and `LSUIElement = true`
//  apps don't surface a Dock window for `XCUIElementTypeWindow` to find. The
//  best signal we can extract here is: the process launches successfully and
//  remains running for at least one runloop tick.
//

import XCTest

@MainActor
final class PanelSummonTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    func testAppLaunchesAndStaysAlive() throws {
        let app = XCUIApplication()
        app.launch()

        // Wait briefly — LSUIElement apps run as agents (no Dock, no main
        // window), so XCTest can't observe `runningForeground`. We assert
        // that the process didn't crash within 1 second of launch.
        let predicate = NSPredicate { _, _ in
            let raw = app.state.rawValue
            // 3 = runningBackground, 4 = runningForeground
            return raw == 3 || raw == 4
        }
        let exp = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        let result = XCTWaiter.wait(for: [exp], timeout: 2.0)
        XCTAssertEqual(result, .completed, "expected app to be running; got state=\(app.state.rawValue)")
    }
}
