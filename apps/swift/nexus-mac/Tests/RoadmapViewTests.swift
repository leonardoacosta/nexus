// RoadmapViewTests — decodes a fixture agent `GET /roadmap` payload into the
// `[RoadmapCapability]` wire models without throwing and asserts the
// non-optional count fields land.
//
// Spec: openspec/changes/add-bead-proposal-roadmap-surface (task 2.7)
//
// The wire JSON is camelCase, so the decoders use synthesized CodingKeys with
// no custom mapping — these tests pin that the field names match the agent's
// packages/core `RoadmapCapability` / `RoadmapProposal` shapes exactly.

import XCTest
@testable import NexusShared

final class RoadmapViewTests: XCTestCase {

    /// A representative `GET /roadmap?project=nx` body: one capability with a
    /// child proposal carrying a full bead rollup.
    private let fixture = """
    {
      "capabilities": [
        {
          "name": "specs-surface",
          "epicId": "nx-0bhyl",
          "epicStatus": "in_progress",
          "proposals": [
            {
              "slug": "add-bead-proposal-roadmap-surface",
              "specStatus": "active",
              "rollup": {
                "epic": { "id": "nx-0bhyl", "status": "in_progress", "type": "epic", "priority": 2, "title": "[CAPABILITY] specs" },
                "feature": { "id": "nx-naeby", "status": "in_progress", "type": "feature", "priority": 2, "title": "roadmap surface" },
                "tasks": { "total": 14, "closed": 9, "ready": 3, "blocked": 1 },
                "beads": [
                  { "id": "nx-iqekj", "status": "closed", "type": "task", "priority": 2, "title": "Swift models" }
                ]
              }
            }
          ],
          "progress": { "totalTasks": 14, "closedTasks": 9 }
        }
      ]
    }
    """.data(using: .utf8)!

    func testRoadmapResponseDecodesWithoutThrowing() throws {
        let env = try JSONDecoder().decode(RoadmapResponse.self, from: fixture)
        XCTAssertEqual(env.capabilities.count, 1)
    }

    func testRoadmapCapabilityFieldsPopulated() throws {
        let env = try JSONDecoder().decode(RoadmapResponse.self, from: fixture)
        let cap = try XCTUnwrap(env.capabilities.first)
        XCTAssertEqual(cap.name, "specs-surface")
        XCTAssertEqual(cap.epicId, "nx-0bhyl")
        XCTAssertEqual(cap.epicStatus, "in_progress")
        // Non-optional aggregate counts (the task's explicit assertion).
        XCTAssertEqual(cap.progress.totalTasks, 14)
        XCTAssertEqual(cap.progress.closedTasks, 9)
        XCTAssertEqual(cap.progress.fraction, 9.0 / 14.0, accuracy: 0.0001)
        XCTAssertEqual(cap.id, "nx-0bhyl") // Identifiable == epicId
    }

    func testRoadmapProposalRollupFieldsPopulated() throws {
        let env = try JSONDecoder().decode(RoadmapResponse.self, from: fixture)
        let proposal = try XCTUnwrap(env.capabilities.first?.proposals.first)
        XCTAssertEqual(proposal.slug, "add-bead-proposal-roadmap-surface")
        XCTAssertEqual(proposal.specStatus, "active")
        XCTAssertEqual(proposal.id, proposal.slug) // Identifiable == slug
        // Non-optional per-proposal rollup counts.
        XCTAssertEqual(proposal.rollup.tasks.total, 14)
        XCTAssertEqual(proposal.rollup.tasks.closed, 9)
        XCTAssertEqual(proposal.rollup.tasks.ready, 3)
        XCTAssertEqual(proposal.rollup.tasks.blocked, 1)
        XCTAssertEqual(proposal.rollup.epic?.id, "nx-0bhyl")
        XCTAssertEqual(proposal.rollup.feature?.type, "feature")
        XCTAssertEqual(proposal.rollup.beads.count, 1)
    }

    func testRoadmapResponseHandlesMissingCapabilitiesKey() throws {
        let env = try JSONDecoder().decode(
            RoadmapResponse.self,
            from: "{}".data(using: .utf8)!
        )
        XCTAssertTrue(env.capabilities.isEmpty)
    }

    func testRoadmapCapabilityToleratesMissingProgress() throws {
        // An older/partial agent may omit `progress`; it must default to
        // zeroed counts rather than throw.
        let json = """
        {
          "capabilities": [
            { "name": "x", "epicId": "nx-x", "epicStatus": "open", "proposals": [] }
          ]
        }
        """.data(using: .utf8)!
        let env = try JSONDecoder().decode(RoadmapResponse.self, from: json)
        let cap = try XCTUnwrap(env.capabilities.first)
        XCTAssertEqual(cap.progress.totalTasks, 0)
        XCTAssertEqual(cap.progress.closedTasks, 0)
        XCTAssertTrue(cap.proposals.isEmpty)
    }
}
