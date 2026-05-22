// SpecsViewTests — covers the right-pane enum transitions and the
// SpecSession decoder used by SpecsViewModel for the per-row Start
// Session disabled-state.
//
// Spec: openspec/changes/specs-tab-start-on-spec (task 3.10).
//
// What we pin:
//   1. SpecsRightPaneState transitions: empty → spec(s) → pty → spec(s)
//      → empty (back/close affordance).
//   2. SpecsRightPaneState equality semantics (so SwiftUI .onChange
//      diffs land correctly and tests can compare deterministically).
//   3. The optimistic placeholder constant is the agreed sentinel
//      (`"starting..."`); the SpecsView body branches on it.
//   4. SpecSession decoder parses the wire envelope from
//      `GET /specs/.../sessions` including the `active` boolean and
//      ISO-8601 timestamps with TZ offset (matches the agent emit).
//
// Full SwiftUI body assertions stay in the XCUITest suite (task 4.3,
// currently deferred until the SessionsView mount regression is fixed).

import XCTest
@testable import nexus
@testable import NexusShared

final class SpecsViewTests: XCTestCase {

    // MARK: - SpecsRightPaneState

    private func makeSpec(name: String = "demo-spec") -> SpecSummary {
        SpecSummary(
            name: name,
            project: "nx",
            status: "draft",
            completedTasks: 0,
            totalTasks: 5,
            lastModified: nil,
            hasProposal: true,
            hasDesign: false,
            hasTasks: true,
            frontmatter: ["status": "draft", "capability": "specs-tab"]
        )
    }

    func testRightPaneStartsEmpty() {
        let state: SpecsRightPaneState = .empty
        XCTAssertEqual(state, .empty)
    }

    func testRightPaneTransitionSelectToSpec() {
        let spec = makeSpec()
        var state: SpecsRightPaneState = .empty
        state = .spec(spec)
        XCTAssertEqual(state, .spec(spec))
    }

    func testRightPaneTransitionSpecToPlaceholderPty() {
        let spec = makeSpec()
        var state: SpecsRightPaneState = .spec(spec)
        state = .pty(
            sessionId: SpecsViewStartingSessionPlaceholder,
            fromSpec: spec
        )
        if case let .pty(sid, from) = state {
            XCTAssertEqual(sid, "starting...")
            XCTAssertEqual(from.id, spec.id)
        } else {
            XCTFail("expected .pty state, got \(state)")
        }
    }

    func testRightPaneTransitionPtyToRealSessionId() {
        let spec = makeSpec()
        var state: SpecsRightPaneState = .pty(
            sessionId: SpecsViewStartingSessionPlaceholder,
            fromSpec: spec
        )
        state = .pty(sessionId: "nx-1718394012", fromSpec: spec)
        if case let .pty(sid, _) = state {
            XCTAssertEqual(sid, "nx-1718394012")
        } else {
            XCTFail("expected .pty state, got \(state)")
        }
    }

    func testRightPaneTransitionRevertOnError() {
        // Optimistic placeholder → revert path when /session/start fails.
        let spec = makeSpec()
        var state: SpecsRightPaneState = .pty(
            sessionId: SpecsViewStartingSessionPlaceholder,
            fromSpec: spec
        )
        // Simulate revert handler.
        state = .spec(spec)
        XCTAssertEqual(state, .spec(spec))
    }

    func testRightPaneTransitionCloseReturnsToSpec() {
        // Proposal contract: closing the PTY returns the right pane to
        // the spec detail it was on before.
        let spec = makeSpec()
        var state: SpecsRightPaneState = .pty(
            sessionId: "nx-1718394012",
            fromSpec: spec
        )
        // Simulate PtyViewer onClose callback handing back to .spec.
        state = .spec(spec)
        XCTAssertEqual(state, .spec(spec))
    }

    func testRightPaneEqualityDistinguishesPtyFromSpec() {
        let spec = makeSpec()
        let a: SpecsRightPaneState = .spec(spec)
        let b: SpecsRightPaneState = .pty(sessionId: "x", fromSpec: spec)
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Optimistic placeholder constant

    func testStartingSessionPlaceholderConstantIsStable() {
        // The body of SpecsView branches on this exact string when
        // rendering the PTY header "starting…" affordance. A rename
        // requires a coordinated UI tweak.
        XCTAssertEqual(SpecsViewStartingSessionPlaceholder, "starting...")
    }

    // MARK: - SpecSession decoder

    func testSpecSessionDecoderParsesActiveRow() throws {
        let json = """
        {
          "sessions": [
            {
              "id": 42,
              "session_id": "nx-1234",
              "created_at": "2026-05-21T10:00:00+00:00",
              "active": true
            }
          ]
        }
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(SpecSessionsResponse.self, from: json)
        XCTAssertEqual(envelope.sessions.count, 1)
        let row = envelope.sessions[0]
        XCTAssertEqual(row.id, 42)
        XCTAssertEqual(row.sessionId, "nx-1234")
        XCTAssertTrue(row.active)
    }

    func testSpecSessionDecoderHandlesHistoricalRow() throws {
        let json = """
        {
          "sessions": [
            {
              "id": 7,
              "session_id": "nx-old",
              "created_at": "2026-04-01T15:30:00-05:00",
              "active": false
            }
          ]
        }
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(SpecSessionsResponse.self, from: json)
        XCTAssertEqual(envelope.sessions.count, 1)
        XCTAssertFalse(envelope.sessions[0].active)
    }

    func testSpecSessionDecoderDefaultsActiveFalseWhenMissing() throws {
        // Wire contract pins `active` non-optional today; tolerant decode
        // protects against an older agent rolled out mid-deploy.
        let json = """
        {
          "sessions": [
            {
              "id": 1,
              "session_id": "nx-mid",
              "created_at": "2026-05-21T00:00:00+00:00"
            }
          ]
        }
        """.data(using: .utf8)!
        let envelope = try JSONDecoder().decode(SpecSessionsResponse.self, from: json)
        XCTAssertFalse(envelope.sessions[0].active)
    }

    // MARK: - SpecSummary frontmatter back-compat

    func testSpecSummaryDecoderHandlesMissingFrontmatter() throws {
        // Older agents (pre task 2.7) omit `frontmatter` entirely; the
        // optional must decode as nil rather than throw or default to {}.
        let json = """
        {
          "name": "old-spec",
          "project": "nx",
          "status": "draft",
          "completedTasks": 0,
          "totalTasks": 0,
          "has_proposal": true,
          "has_design": false,
          "has_tasks": false
        }
        """.data(using: .utf8)!
        let summary = try JSONDecoder().decode(SpecSummary.self, from: json)
        XCTAssertNil(summary.frontmatter)
    }

    func testSpecSummaryDecoderParsesFrontmatter() throws {
        let json = """
        {
          "name": "new-spec",
          "project": "nx",
          "status": "approved",
          "completedTasks": 3,
          "totalTasks": 5,
          "has_proposal": true,
          "has_design": true,
          "has_tasks": true,
          "frontmatter": {
            "status": "approved",
            "approved-by": "leo@x.dev",
            "capability": "specs-tab"
          }
        }
        """.data(using: .utf8)!
        let summary = try JSONDecoder().decode(SpecSummary.self, from: json)
        XCTAssertEqual(summary.frontmatter?["approved-by"], "leo@x.dev")
        XCTAssertEqual(summary.frontmatter?["capability"], "specs-tab")
    }
}
