//
//  TmuxWindowNameTests.swift
//  nexusTests
//
//  Per design.md §A2 + spec scenario "Click ATTACH on an active session":
//  client reconstructs `<project>-<timestamp>` from session metadata. The
//  agent's source of truth is `apps/agent/src/routes/sessions.ts:239`:
//      const ts = Date.now();
//      const sessionName = `${body.project}-${ts}`;
//  Timestamps are milliseconds since epoch.
//

import XCTest
@testable import nexus

final class TmuxWindowNameTests: XCTestCase {

    func testReconstructsProjectAndMillisecondTimestamp() {
        // Agent uses Date.now() which is ms-since-epoch.
        let ms: Int64 = 1_715_900_000_000
        let started = Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
        let session = NexusSession(
            id: "abc",
            project: "nx",
            startedAt: started
        )
        XCTAssertEqual(session.resolvedTmuxWindow, "nx-\(ms)")
    }

    func testServerProvidedTmuxTargetWins() {
        // If the agent ever surfaces `tmuxTarget`, it should win over the
        // client-side reconstruction (design.md §A2 follow-up).
        let session = NexusSession(
            id: "abc",
            project: "nx",
            startedAt: Date(),
            tmuxTarget: "homelab-window-7"
        )
        XCTAssertEqual(session.resolvedTmuxWindow, "homelab-window-7")
    }

    func testFallbacksWhenProjectMissing() {
        let session = NexusSession(
            id: "z",
            project: nil,
            projectId: "uuid-1234",
            startedAt: Date(timeIntervalSince1970: 1)
        )
        // Falls back to projectId when no friendly name is present.
        XCTAssertTrue(session.resolvedTmuxWindow.hasPrefix("uuid-1234-"),
                      "got: \(session.resolvedTmuxWindow)")
    }
}
