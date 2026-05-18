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
}
