// SessionRowTests — exercise the project-label degradation chain used by
// SessionsRowView (nexus-mac dashboard) without binding to SwiftUI.
//
// Spec: openspec/changes/session-row-enrichment-v1 (task 3.1, beads nx-l1agm)
//
// The label helper itself lives on `Session` (NexusShared) so it's reachable
// from this test target via `@testable import NexusShared`. Cost / idle /
// duration rendering is covered by other tests; this file pins ONLY the
// `gitOwnerRepo -> projectId -> cwd basename -> "—"` ladder.

import XCTest
@testable import NexusShared

final class SessionRowTests: XCTestCase {
    /// gitOwnerRepo wins the ladder even when projectId + cwd are present —
    /// `leonardoacosta/oo` is more readable than a UUID-shaped projectId.
    func testGitOwnerRepoPresentRendersOwnerRepo() {
        let session = Session(
            id: "s1",
            projectId: "11111111-2222-3333-4444-555555555555",
            cwd: "/home/nyaptor/dev/oo",
            gitOwnerRepo: "leonardoacosta/oo"
        )
        XCTAssertEqual(Session.projectLabel(for: session), "leonardoacosta/oo")
    }

    /// Falls through to projectId when gitOwnerRepo is absent (legacy rows
    /// from before git-project-resolver landed, or sessions in repos without
    /// a remote).
    func testProjectIdOnlyRendersProjectId() {
        let session = Session(
            id: "s2",
            projectId: "tc-dashboard",
            cwd: "/home/leo/dev/tc",
            gitOwnerRepo: nil
        )
        XCTAssertEqual(Session.projectLabel(for: session), "tc-dashboard")
    }

    /// cwd basename is the last-resort textual fallback before "—".
    /// Picks the trailing path component so `/home/user/dev/oo` renders `oo`.
    func testCwdOnlyRendersBasename() {
        let session = Session(
            id: "s3",
            projectId: nil,
            cwd: "/home/user/dev/oo",
            gitOwnerRepo: nil
        )
        XCTAssertEqual(Session.projectLabel(for: session), "oo")
    }

    /// All fields empty / nil — the view still has to render something, so
    /// we emit the em-dash placeholder rather than a blank row.
    func testAllNullRendersDash() {
        let session = Session(
            id: "s4",
            projectId: nil,
            cwd: nil,
            gitOwnerRepo: nil
        )
        XCTAssertEqual(Session.projectLabel(for: session), "—")
    }
}
