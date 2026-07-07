// DecideVerdictDecodeTests — the additive-verdict decode contract for the decide
// pilot (openspec/changes/add-decide-flow-menubar, NexusShared task 2.7).
//
// Proves BOTH payload shapes decode:
//   • verdict-PRESENT  → the nested Verdict populates, rest of the item unchanged.
//   • verdict-ABSENT   → a pre-verdict gateway payload decodes IDENTICALLY, with
//                        `verdict == nil` (the additive guarantee).

import XCTest
@testable import NexusShared

final class DecideVerdictDecodeTests: XCTestCase {

    private func decode(_ json: String) throws -> TriageItem {
        try JSONDecoder().decode(TriageItem.self, from: Data(json.utf8))
    }

    // MARK: - Verdict present

    func testDecodesVerdictPresentPayload() throws {
        let json = """
        {
          "id": "ado:wi:4821",
          "source": "ado",
          "kind": "WORK_ITEM",
          "title": "AB#4821 · auth retry",
          "ball_in_court": "MINE",
          "summary": "reviewer waiting on you",
          "priority": "PRIORITY_HIGH",
          "suggested_disposition": "OPEN",
          "verdict": {
            "action": "delegate",
            "disposition": "open",
            "reason": "hand to on-call",
            "confidence": 0.82,
            "prompt_version": "decide-v1",
            "verdict_id": "vd_4821"
          }
        }
        """
        let item = try decode(json)

        // Verdict populated.
        let verdict = try XCTUnwrap(item.verdict, "verdict must decode when present")
        XCTAssertEqual(verdict.action, "delegate")
        XCTAssertEqual(verdict.disposition, "open")
        XCTAssertEqual(verdict.reason, "hand to on-call")
        XCTAssertEqual(verdict.confidence, 0.82)
        XCTAssertEqual(verdict.confidenceBand, "high")
        XCTAssertEqual(verdict.promptVersion, "decide-v1")
        XCTAssertEqual(verdict.verdictId, "vd_4821")
        XCTAssertTrue(verdict.isActionable)

        // Rest of the item still decodes normally.
        XCTAssertEqual(item.id, "ado:wi:4821")
        XCTAssertEqual(item.source, "ado")
        XCTAssertEqual(item.kind, .workItem)
        XCTAssertEqual(item.ballInCourt, .mine)
        XCTAssertEqual(item.payload.comms?.summary, "reviewer waiting on you")
    }

    // MARK: - Verdict absent (additive guarantee)

    func testDecodesVerdictAbsentPayloadUnchanged() throws {
        let json = """
        {
          "id": "gmail:msg:8841",
          "source": "gmail",
          "kind": "EMAIL",
          "title": "Q3 contract redline",
          "ball_in_court": "MINE",
          "summary": "approve before 5pm",
          "priority": "PRIORITY_URGENT",
          "suggested_disposition": "INBOX"
        }
        """
        let item = try decode(json)

        // No verdict — the pre-verdict steady state.
        XCTAssertNil(item.verdict, "a pre-verdict payload must decode with verdict == nil")

        // Everything else decodes exactly as before the additive field.
        XCTAssertEqual(item.id, "gmail:msg:8841")
        XCTAssertEqual(item.source, "gmail")
        XCTAssertEqual(item.kind, .email)
        XCTAssertEqual(item.ballInCourt, .mine)
        XCTAssertEqual(item.payload.comms?.summary, "approve before 5pm")
        XCTAssertEqual(item.payload.comms?.priority, .urgent)
    }

    // MARK: - Tolerant confidence + partial verdict

    func testConfidenceBandStringFallback() throws {
        // Gateway emits a band STRING under `confidence` instead of a score.
        let json = """
        { "id": "x", "source": "s", "kind": "EMAIL", "title": "t",
          "verdict": { "action": "defer", "confidence": "medium", "verdict_id": "v1" } }
        """
        let item = try decode(json)
        let verdict = try XCTUnwrap(item.verdict)
        XCTAssertNil(verdict.confidence, "a band string is not a numeric score")
        XCTAssertEqual(verdict.confidenceBand, "medium")
        XCTAssertTrue(verdict.isActionable)
    }

    func testPartialVerdictWithoutIdIsNotActionable() throws {
        // A verdict object with no verdict_id -> present but not actionable
        // (renders skip-only in the UI).
        let json = """
        { "id": "x", "source": "s", "kind": "EMAIL", "title": "t",
          "verdict": { "action": "resolve" } }
        """
        let item = try decode(json)
        let verdict = try XCTUnwrap(item.verdict)
        XCTAssertEqual(verdict.action, "resolve")
        XCTAssertNil(verdict.verdictId)
        XCTAssertFalse(verdict.isActionable)
    }

    // MARK: - camelCase alias

    func testDecodesCamelCaseVerdictKeys() throws {
        let json = """
        { "id": "x", "source": "s", "kind": "EMAIL", "title": "t",
          "verdict": { "action": "group", "promptVersion": "v2", "verdictId": "v9",
                       "confidenceBand": "low" } }
        """
        let item = try decode(json)
        let verdict = try XCTUnwrap(item.verdict)
        XCTAssertEqual(verdict.promptVersion, "v2")
        XCTAssertEqual(verdict.verdictId, "v9")
        XCTAssertEqual(verdict.confidenceBand, "low")
    }
}
