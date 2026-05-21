// SessionRowTests — exercise the project-label degradation chain used by
// SessionsRowView (nexus-mac dashboard) without binding to SwiftUI.
//
// Spec: openspec/changes/session-row-enrichment-v1 (task 3.1, beads nx-l1agm).
// nx-ds6rq dropped the "pid <N>" rung after the process-watcher began
// pulling cwd from tmux — watcher rows now always carry cwd, so the pid
// fallback was leaking a kernel-internal value to the user-facing title.
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

    /// nx-ds6rq: a session whose only identifier is a pid no longer renders
    /// `pid <N>` — that rung was dropped after the process-watcher started
    /// pulling cwd from tmux. Watcher rows now always carry cwd; sessions
    /// that fall through all three textual rungs render the em-dash so the
    /// dashboard doesn't leak a kernel value into a user-facing title.
    func testPidOnlyRendersDash() {
        let session = Session(
            id: "s4",
            projectId: nil,
            pid: 1234,
            cwd: nil,
            gitOwnerRepo: nil
        )
        XCTAssertEqual(Session.projectLabel(for: session), "—")
    }

    /// All textual fields empty / nil — the view still has to render
    /// something, so we emit the em-dash placeholder rather than a blank row.
    /// (pid is irrelevant to the label; metaLine carries it separately.)
    func testAllNullRendersDash() {
        let session = Session(
            id: "s5",
            projectId: nil,
            pid: nil,
            cwd: nil,
            gitOwnerRepo: nil
        )
        XCTAssertEqual(Session.projectLabel(for: session), "—")
    }

    /// metaLine — `pid <N> · <machine>` when pid > 0.
    func testMetaLineWithPidShowsBothSegments() {
        let session = Session(
            id: "s6",
            machine: "mac-mini-01",
            agent: nil,
            pid: 9876,
            gitOwnerRepo: "leonardoacosta/oo"
        )
        XCTAssertEqual(Session.metaLine(for: session), "pid 9876 · mac-mini-01")
    }

    /// metaLine — falls back to originAgent alone when pid is nil/zero.
    func testMetaLineWithoutPidShowsOriginAgentOnly() {
        let session = Session(
            id: "s7",
            machine: "homelab-01",
            agent: nil,
            pid: nil
        )
        XCTAssertEqual(Session.metaLine(for: session), "homelab-01")
    }
}
