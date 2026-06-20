// FleetPresenceIndicatorTests — pure view-model derivation from a stubbed
// fleet response (no live agent).
//
// Spec: openspec/changes/cross-machine-delivery (Phase 1.6), requirement
// "Fleet Presence Dashboard Indicator" (nx-f3w74).
//
// `FleetRouteSummary.derive` is the testable core: it maps a
// `FleetPresenceResponse` to the indicator's two display lines + the
// is-local flag, with NO network. The view is a thin shell over it, so these
// assertions cover the routing-destination logic the requirement demands:
//   - live console == local Mac -> "this Mac"
//   - live console == a peer    -> that peer's name in both lines

import XCTest
@testable import nexus
@testable import NexusShared

final class FleetPresenceIndicatorTests: XCTestCase {

    // MARK: - Live console == local -> "this Mac"

    func testLiveConsoleEqualsLocalRoutesToThisMac() {
        let response = FleetPresenceResponse(
            machines: [
                FleetMachine(machine: "studio", onConsole: true, macActive: true, macLocked: false),
                FleetMachine(machine: "homelab", onConsole: false),
            ],
            liveConsole: "studio",
            localMachine: "studio"
        )

        let summary = FleetRouteSummary.derive(from: response)

        XCTAssertTrue(summary.isLocal, "live console == local must resolve as local")
        XCTAssertEqual(summary.routeLine, "notifications → this Mac")
        XCTAssertEqual(summary.consoleLine, "live console: this Mac")
    }

    // MARK: - Live console == peer -> that peer's name

    func testLiveConsoleEqualsPeerRoutesToPeer() {
        let response = FleetPresenceResponse(
            machines: [
                FleetMachine(machine: "studio", onConsole: false),
                FleetMachine(machine: "homelab", onConsole: true, macActive: true, macLocked: false),
            ],
            liveConsole: "homelab",
            localMachine: "studio"
        )

        let summary = FleetRouteSummary.derive(from: response)

        XCTAssertFalse(summary.isLocal, "live console == peer must resolve as remote")
        XCTAssertEqual(summary.routeLine, "notifications → homelab")
        XCTAssertEqual(summary.consoleLine, "live console: homelab")
    }

    // MARK: - Empty live console falls back to local (lossless)

    func testEmptyLiveConsoleFallsBackToLocal() {
        // The agent resolves an empty live console when nothing is on-console;
        // the indicator must treat that as local, never a blank destination.
        let response = FleetPresenceResponse(
            machines: [],
            liveConsole: "",
            localMachine: "studio"
        )

        let summary = FleetRouteSummary.derive(from: response)

        XCTAssertTrue(summary.isLocal)
        XCTAssertEqual(summary.routeLine, "notifications → this Mac")
    }

    // MARK: - Wire decode: camelCase fleet_presence rows

    func testDecodesCamelCaseFleetResponse() throws {
        // The agent serializes drizzle $inferSelect rows -> camelCase keys.
        let json = """
        {
          "machines": [
            { "machine": "studio", "onConsole": true, "macActive": true, "macLocked": false,
              "heartbeat": "2026-06-19T12:00:00.000Z", "updatedAt": "2026-06-19T12:00:00.000Z" }
          ],
          "liveConsole": "studio",
          "localMachine": "homelab"
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(FleetPresenceResponse.self, from: json)

        XCTAssertEqual(response.liveConsole, "studio")
        XCTAssertEqual(response.localMachine, "homelab")
        XCTAssertEqual(response.machines.count, 1)
        XCTAssertEqual(response.machines.first?.machine, "studio")
        XCTAssertEqual(response.machines.first?.onConsole, true)
        XCTAssertNotNil(response.machines.first?.heartbeat)

        // studio is the live console but homelab is local -> routes to peer.
        let summary = FleetRouteSummary.derive(from: response)
        XCTAssertFalse(summary.isLocal)
        XCTAssertEqual(summary.routeLine, "notifications → studio")
    }
}
