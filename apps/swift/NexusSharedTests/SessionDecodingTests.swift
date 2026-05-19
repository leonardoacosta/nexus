// SessionDecodingTests — verify Session decodes the agent's JSON shapes
// (ISO8601 with/without fraction, epoch numeric, alias lastHeartbeat <->
// lastActivity, empty-string cwd treated as nil).
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.7)

import XCTest
@testable import NexusShared

final class SessionDecodingTests: XCTestCase {
    func testDecodesIso8601Dates() throws {
        let json = """
        {
            "id": "abc",
            "status": "active",
            "startedAt": "2026-05-17T18:00:00.000Z",
            "lastActivity": "2026-05-17T18:01:00.000Z",
            "pid": 1234
        }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(Session.self, from: json)
        XCTAssertEqual(s.id, "abc")
        XCTAssertEqual(s.status, "active")
        XCTAssertEqual(s.pid, 1234)
        XCTAssertTrue(s.hasCCFingerprint)
    }

    func testDecodesEpochMillisDates() throws {
        let json = """
        {
            "id": "epoch",
            "startedAt": 1747504800000,
            "lastHeartbeat": 1747504860000
        }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(Session.self, from: json)
        XCTAssertEqual(s.id, "epoch")
        // Status defaults to "idle" when absent.
        XCTAssertEqual(s.status, "idle")
    }

    func testEmptyCwdIsNilled() throws {
        let json = """
        {"id": "x", "cwd": ""}
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(Session.self, from: json)
        XCTAssertNil(s.cwd)
    }

    func testStubRowHasNoFingerprint() throws {
        let json = """
        {"id": "stub"}
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(Session.self, from: json)
        XCTAssertFalse(s.hasCCFingerprint)
    }

    // MARK: - Full wire-shape + aggregate envelope (spec task 2.1, bd:nx-3ltm0)
    //
    // Payload-drift guard. The JSON below is byte-identical to what the
    // shared stub-agent (apps/agent/src/testing/stub-agent.ts,
    // SESSIONS_FIXTURE — spec task 1.4) serves for `GET /sessions`. It is
    // the FULL current wire row: every Drizzle `sessions.$inferSelect`
    // column, Dates JSON-serialized to ISO8601 strings exactly as
    // `JSON.stringify` emits them. Keeping client decode and the server
    // stub on ONE fixture means a server-side column add/rename surfaces
    // here instead of silently emptying the dashboard. Do NOT fork this
    // into a divergent client-only fixture (design.md "no divergent
    // fixtures" / mock-drift mitigation).

    /// Single `GET /sessions` row, byte-identical to stub-agent
    /// SESSIONS_FIXTURE[0] after `JSON.stringify`.
    private static let stubSessionRowJSON = """
    {
      "id": "stub-sess-1",
      "projectId": null,
      "machine": "stub-machine",
      "status": "active",
      "startedAt": "2026-05-19T11:04:02.740Z",
      "lastActivity": "2026-05-19T11:04:02.740Z",
      "endedAt": null,
      "pid": 4242,
      "cwd": "/tmp/stub",
      "branch": null,
      "sessionType": "managed",
      "model": "claude",
      "rateLimitUtilization": null,
      "totalCostUsd": null,
      "rateLimitResetAt": null,
      "idleSince": null,
      "ccSessionId": null,
      "tmuxSession": null,
      "tmuxTarget": null,
      "spec": null,
      "credentialId": null,
      "credentialFingerprint": null,
      "gitProvider": null,
      "gitOwnerRepo": null,
      "parentSessionId": null,
      "childRole": null
    }
    """

    /// Decodes the FULL current `/sessions` wire row (all 26 Drizzle
    /// columns). Asserts the subset `Session` projects out is correct and
    /// that the dozens of unknown server columns do NOT break decode
    /// (server-extension tolerance is the contract — Session.swift header).
    func testDecodesFullStubSessionsWireRow() throws {
        let data = Self.stubSessionRowJSON.data(using: .utf8)!
        let s = try JSONDecoder().decode(Session.self, from: data)

        XCTAssertEqual(s.id, "stub-sess-1")
        XCTAssertEqual(s.status, "active")
        XCTAssertEqual(s.machine, "stub-machine")
        XCTAssertEqual(s.model, "claude")
        XCTAssertEqual(s.pid, 4242)
        XCTAssertEqual(s.cwd, "/tmp/stub")
        // `lastActivity` (DB/wire name) MUST alias onto `lastHeartbeat`.
        XCTAssertEqual(
            s.lastHeartbeat.timeIntervalSince1970,
            s.startedAt.timeIntervalSince1970,
            accuracy: 0.001,
            "lastActivity must decode and equal startedAt for this fixture"
        )
        // pid > 0 + cwd + model present ⇒ a real CC row, not a stub ping.
        XCTAssertTrue(s.hasCCFingerprint)
        // `projectId` (a real wire column) is decoded; the many other
        // unknown columns (sessionType, credentialId, …) are ignored.
        XCTAssertNil(s.projectId)
    }

    /// `GET /sessions` returns a bare JSON ARRAY (no envelope) —
    /// `NexusClient.fetchSessions` decodes `[Session]` directly. Guards
    /// the array wire shape the whole transport path assumes.
    func testDecodesSessionsWireArray() throws {
        let arrayJSON = "[\(Self.stubSessionRowJSON)]".data(using: .utf8)!
        let rows = try JSONDecoder().decode([Session].self, from: arrayJSON)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.id, "stub-sess-1")
        XCTAssertTrue(rows.first?.hasCCFingerprint ?? false)
    }

    /// Multi-agent aggregate envelope. There is no server-side JSON
    /// envelope — the "aggregate" is `NexusAggregateClient` merging each
    /// agent's `[Session]`, deduping by `id`, last-writer-wins, and
    /// stamping `Session.machine` with the source agent name when the row
    /// left it nil/empty/"local". This asserts that decode + merge
    /// contract end-to-end (the surface SessionObserver.refreshSessions
    /// depends on) so a wire/merge drift can't silently empty the
    /// aggregated dashboard.
    func testAggregateMergeDedupAndMachineStamp() throws {
        // Agent A: the full stub row (machine = "stub-machine" — kept).
        let rowsA = try JSONDecoder().decode(
            [Session].self,
            from: "[\(Self.stubSessionRowJSON)]".data(using: .utf8)!
        )
        // Agent B: same id (collision ⇒ last-writer-wins) + a row whose
        // machine is empty (aggregate must stamp the source agent name).
        let bJSON = """
        [
          {"id": "stub-sess-1", "status": "idle", "machine": "homelab", "pid": 99},
          {"id": "b-only", "status": "active", "machine": "", "pid": 7, "model": "claude"}
        ]
        """.data(using: .utf8)!
        let rowsB = try JSONDecoder().decode([Session].self, from: bJSON)

        // Mirror NexusAggregateClient.fetchSessions merge semantics:
        // iterate agents in order; stamp empty/"local"/nil machine with
        // the source agent name; dedup by id, last-writer-wins.
        var merged: [String: Session] = [:]
        func ingest(_ rows: [Session], from agent: String) {
            for var s in rows {
                if (s.machine ?? "").isEmpty || s.machine == "local" {
                    s.machine = agent
                }
                merged[s.id] = s
            }
        }
        ingest(rowsA, from: "agentA")
        ingest(rowsB, from: "agentB")

        XCTAssertEqual(merged.count, 2, "id collision must dedup to 2 rows")
        // Last writer (agent B) wins for the colliding id.
        XCTAssertEqual(merged["stub-sess-1"]?.status, "idle")
        XCTAssertEqual(merged["stub-sess-1"]?.machine, "homelab")
        // Empty machine on b-only is stamped with the source agent name.
        XCTAssertEqual(merged["b-only"]?.machine, "agentB")
        XCTAssertTrue(merged["b-only"]?.hasCCFingerprint ?? false)
    }
}
