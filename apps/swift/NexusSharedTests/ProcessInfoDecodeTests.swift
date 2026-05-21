// ProcessInfoDecodeTests — pin the Swift Codable mirror for ProcessInfo
// against both the legacy (4-field) and extended (7-field) wire shapes.
//
// Spec: openspec/changes/health-tab-process-view (requirement
// `process-info-extended-fields`).
//
// The Swift dashboard MUST decode both shapes:
//   - Old agents: `{ pid, name, cpu_percent, ram_percent }`
//   - New agents: `{ pid, name, cpu_percent, ram_percent, command, user, state }`
// Missing or null optional fields decode to nil — the UI then chooses how
// to render (e.g. hide caption, render `uid:NNNN`, etc.).

import XCTest
@testable import NexusShared

final class ProcessInfoDecodeTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        let data = Data(json.utf8)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// New (6+) field payload — every optional field populated.
    func testDecodesNewPayloadShapeWithAllOptionalFieldsPresent() throws {
        let json = """
        {
            "pid": 12345,
            "name": "claude",
            "cpu_percent": 23.4,
            "ram_percent": 1.2,
            "command": "/usr/local/bin/claude --resume abc123",
            "user": "leonardoacosta",
            "state": "S"
        }
        """
        let proc = try decode(HealthMetrics.ProcessInfo.self, json)
        XCTAssertEqual(proc.pid, 12345)
        XCTAssertEqual(proc.name, "claude")
        XCTAssertEqual(proc.cpuPercent, 23.4, accuracy: 0.001)
        XCTAssertEqual(proc.ramPercent, 1.2, accuracy: 0.001)
        XCTAssertEqual(proc.command, "/usr/local/bin/claude --resume abc123")
        XCTAssertEqual(proc.user, "leonardoacosta")
        XCTAssertEqual(proc.state, "S")
    }

    /// Legacy (4-field) payload — `command`, `user`, `state` absent. Must
    /// decode without throwing; optional fields default to nil.
    func testDecodesLegacyPayloadShapeWithFieldsAbsent() throws {
        let json = """
        {
            "pid": 9999,
            "name": "node",
            "cpu_percent": 5.0,
            "ram_percent": 2.3
        }
        """
        let proc = try decode(HealthMetrics.ProcessInfo.self, json)
        XCTAssertEqual(proc.pid, 9999)
        XCTAssertEqual(proc.name, "node")
        XCTAssertEqual(proc.cpuPercent, 5.0, accuracy: 0.001)
        XCTAssertEqual(proc.ramPercent, 2.3, accuracy: 0.001)
        XCTAssertNil(proc.command)
        XCTAssertNil(proc.user)
        XCTAssertNil(proc.state)
    }

    /// New payload with explicit `null` for optional fields — must NOT throw.
    /// (This is the canonical "agent emitted but the row was stripped"
    /// case from the missing-field-tolerance scenario.)
    func testDecodesPayloadWithExplicitNullOptionals() throws {
        let json = """
        {
            "pid": 7,
            "name": "legacy",
            "cpu_percent": 0.5,
            "ram_percent": 0.1,
            "command": null,
            "user": null,
            "state": null
        }
        """
        let proc = try decode(HealthMetrics.ProcessInfo.self, json)
        XCTAssertEqual(proc.pid, 7)
        XCTAssertNil(proc.command)
        XCTAssertNil(proc.user)
        XCTAssertNil(proc.state)
    }

    /// Truncated command (200 chars + ellipsis) round-trips intact — the
    /// UI relies on this to render the trailing `…` indicator.
    func testTruncatedCommandRoundtrip() throws {
        let truncated = String(repeating: "a", count: 200) + "…"
        let json = """
        {
            "pid": 100,
            "name": "build",
            "cpu_percent": 50,
            "ram_percent": 10,
            "command": "\(truncated)",
            "user": "leo",
            "state": "R"
        }
        """
        let proc = try decode(HealthMetrics.ProcessInfo.self, json)
        // 200 chars + the ellipsis (1 Unicode scalar, but its UTF-8 length
        // is 3 bytes). We assert the visible character count, not byte
        // count, mirroring the agent-side contract.
        XCTAssertEqual(proc.command?.count, 201)
        XCTAssertEqual(proc.command?.last, "…")
    }
}
