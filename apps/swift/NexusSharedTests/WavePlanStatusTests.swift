// WavePlanStatusTests — pin the Swift Codable mirror of the agent's
// `GET /wave-plans/active` wire shape (camelCase) against canonical
// payloads. A drift in the agent's projection or our decoder surfaces
// here as a test failure instead of a silently-empty Specs tab.
//
// Spec: openspec/changes/specs-tab-accordion-with-topology (task 3.1)
//       Source of truth: apps/agent/src/routes/wave-plans.ts
//
// What we cover:
//   - Full payload: runId + planName + 2 specStatuses decodes; isActive
//     is true; lookupSpec returns the right row by name.
//   - Empty payload: runId/specStatuses null/empty; isActive is false
//     (covers the "agent up, no /apply active" steady state).
//   - lookupSpec(name:) returns nil when the requested spec is absent
//     from a populated payload.
//
// Decoder strategy mirrors PayloadDecodeTests / SessionDecodingTests:
// plain JSONDecoder, models own their CodingKeys (no global key strategy
// — WavePlanStatus uses camelCase end-to-end matching the wire).

import XCTest
@testable import NexusShared

final class WavePlanStatusTests: XCTestCase {

    // MARK: - Decoder helper

    /// Decode `T` from an inline JSON string. Matches the production
    /// decode path in `NexusClient.fetchWavePlanStatus`.
    private func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(type, from: data)
    }

    // MARK: - Full payload

    /// Contract: apps/agent/src/routes/wave-plans.ts emits this shape
    /// when `docs/apply/active.txt` resolves to a wave-plan.json with at
    /// least one dispatched spec. All fields populated; specStatuses[]
    /// non-empty; per-spec status uses the canonical snake_case enum
    /// (`in_progress`, `completed`).
    func testDecodesFullPayload() throws {
        let json = """
        {
            "runId": "apply-2026-05-17-002",
            "planName": "specs-tab-accordion-with-topology",
            "status": "in_progress",
            "currentWave": 2,
            "currentPhase": "UI",
            "specStatuses": [
                {
                    "name": "specs-tab-accordion-with-topology",
                    "wave": 2,
                    "status": "in_progress",
                    "phase": "UI",
                    "dispatchedAt": "2026-05-17T18:00:00.000Z"
                },
                {
                    "name": "agent-payload-completeness",
                    "wave": 1,
                    "status": "completed",
                    "phase": "API"
                }
            ]
        }
        """
        let payload = try decode(WavePlanStatus.self, from: json)

        // Top-level fields populated.
        XCTAssertEqual(payload.runId, "apply-2026-05-17-002")
        XCTAssertEqual(payload.planName, "specs-tab-accordion-with-topology")
        XCTAssertEqual(payload.status, "in_progress")
        XCTAssertEqual(payload.currentWave, 2)
        XCTAssertEqual(payload.currentPhase, "UI")
        XCTAssertEqual(payload.specStatuses.count, 2)
        XCTAssertNil(payload.error, "no `error` field in a healthy payload")

        // isActive contract: runId present + specStatuses non-empty.
        XCTAssertTrue(payload.isActive, "a populated payload reports isActive=true")

        // lookupSpec returns the matching row with all fields decoded.
        let active = payload.lookupSpec(name: "specs-tab-accordion-with-topology")
        XCTAssertNotNil(active)
        XCTAssertEqual(active?.wave, 2)
        XCTAssertEqual(active?.status, .in_progress)
        XCTAssertEqual(active?.phase, "UI")
        XCTAssertNotNil(active?.dispatchedAt, "ISO8601 with fraction must decode")

        let done = payload.lookupSpec(name: "agent-payload-completeness")
        XCTAssertEqual(done?.status, .completed)
        XCTAssertEqual(done?.wave, 1)
        XCTAssertEqual(done?.phase, "API")
        XCTAssertNil(done?.dispatchedAt, "missing dispatchedAt decodes as nil")
    }

    // MARK: - Empty payload

    /// Contract: when `docs/apply/active.txt` is absent or the agent
    /// detects no in-flight run, every field is explicit null and
    /// `specStatuses` is an empty array. The decoder must accept it and
    /// `isActive` must read false so dashboards stay in the steady-state
    /// "nothing dispatched" UI without surfacing a degraded chip.
    func testDecodesEmptyPayload() throws {
        let json = """
        {
            "runId": null,
            "planName": null,
            "status": null,
            "currentWave": null,
            "currentPhase": null,
            "specStatuses": []
        }
        """
        let payload = try decode(WavePlanStatus.self, from: json)

        XCTAssertNil(payload.runId)
        XCTAssertNil(payload.planName)
        XCTAssertNil(payload.status)
        XCTAssertNil(payload.currentWave)
        XCTAssertNil(payload.currentPhase)
        XCTAssertTrue(payload.specStatuses.isEmpty)
        XCTAssertNil(payload.error)
        XCTAssertFalse(
            payload.isActive,
            "empty payload (runId nil, no specs) MUST read isActive=false"
        )
    }

    // MARK: - lookupSpec miss

    /// Contract: lookupSpec returns nil when the requested name is not
    /// present in `specStatuses`. SpecsView depends on this to skip
    /// rendering wave chips on rows that are NOT part of the active run
    /// (vs. silently showing a default-zero chip on every row).
    func testLookupSpecReturnsNilForMissing() throws {
        let json = """
        {
            "runId": "apply-2026-05-17-002",
            "planName": "specs-tab-accordion-with-topology",
            "status": "in_progress",
            "currentWave": 1,
            "currentPhase": "API",
            "specStatuses": [
                {
                    "name": "specs-tab-accordion-with-topology",
                    "wave": 1,
                    "status": "dispatched",
                    "phase": "API"
                }
            ]
        }
        """
        let payload = try decode(WavePlanStatus.self, from: json)
        XCTAssertTrue(payload.isActive)
        XCTAssertNotNil(payload.lookupSpec(name: "specs-tab-accordion-with-topology"))
        XCTAssertNil(
            payload.lookupSpec(name: "not-in-this-wave-plan"),
            "lookupSpec returns nil when the spec is not part of the active run"
        )
        XCTAssertNil(
            payload.lookupSpec(name: ""),
            "empty-string lookup must also return nil (no accidental empty-name match)"
        )
    }
}
