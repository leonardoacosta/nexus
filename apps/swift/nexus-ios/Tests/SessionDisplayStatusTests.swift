// SessionDisplayStatusTests — the pure agentState/liveness -> dot mapping and
// the client-side parallel-agents overlay (mx-rkir.5). SessionDisplayStatus
// lives in the nexus-ios app target, so this bundle loads the app
// (`@testable import nexus`) to reach it; Session comes from NexusShared.

import XCTest
import NexusShared
@testable import nexus

final class SessionDisplayStatusTests: XCTestCase {

    private func session(
        status: String = "active",
        agentState: AgentState? = nil,
        endedAt: Date? = nil,
        parentSessionId: String? = nil,
        isMonitorSession: Bool? = nil
    ) -> Session {
        Session(
            id: "s",
            status: status,
            endedAt: endedAt,
            agentState: agentState,
            parentSessionId: parentSessionId,
            isMonitorSession: isMonitorSession
        )
    }

    // MARK: - agentState axis (mx-rkir.4 mapping, unchanged)

    func testBlockedMapsToActivelyRunning() {
        XCTAssertEqual(SessionDisplayStatus.derive(from: session(agentState: .blocked)), .activelyRunning)
    }

    func testWaitingMapsToWaitingForMe() {
        XCTAssertEqual(SessionDisplayStatus.derive(from: session(agentState: .waiting)), .waitingForMe)
    }

    func testReadyMapsToWaitingReady() {
        XCTAssertEqual(SessionDisplayStatus.derive(from: session(agentState: .ready)), .waitingReady)
    }

    // MARK: - liveness fallback (no agentState)

    func testNoAgentStateActiveFallsBackToWaitingReady() {
        XCTAssertEqual(SessionDisplayStatus.derive(from: session(status: "active", agentState: nil)), .waitingReady)
    }

    func testNoAgentStateIdleFallsBackToStale() {
        XCTAssertEqual(SessionDisplayStatus.derive(from: session(status: "idle", agentState: nil)), .stale)
    }

    // MARK: - ended-ness wins

    func testEndedAtWinsOverAgentState() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked, endedAt: Date())),
            .stale
        )
    }

    func testStatusEndedIsStale() {
        XCTAssertEqual(SessionDisplayStatus.derive(from: session(status: "ended")), .stale)
    }

    // MARK: - parallel-agents overlay (mx-rkir.5)

    func testFanOutParentWithBlockedShowsParallelAgents() {
        // A busy orchestrator (SubagentStart marks the parent .blocked) with
        // live children surfaces as parallelAgents, not activelyRunning.
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked), hasActiveChildren: true),
            .parallelAgents
        )
    }

    func testFanOutParentWithReadyShowsParallelAgents() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .ready), hasActiveChildren: true),
            .parallelAgents
        )
    }

    func testWaitingForMeWinsOverParallelAgents() {
        // Needs-my-input is the most actionable state and wins over the
        // background fan-out overlay.
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .waiting), hasActiveChildren: true),
            .waitingForMe
        )
    }

    func testEndedWinsOverParallelAgents() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked, endedAt: Date()), hasActiveChildren: true),
            .stale
        )
    }

    func testNoChildrenKeepsBaselineMapping() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked), hasActiveChildren: false),
            .activelyRunning
        )
    }

    // MARK: - Monitor-tool classification (mx-rkir.5)

    func testMonitorSessionMapsToMonitor() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked, isMonitorSession: true)),
            .monitor
        )
    }

    func testNonMonitorSessionUnaffected() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked, isMonitorSession: false)),
            .activelyRunning
        )
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked, isMonitorSession: nil)),
            .activelyRunning
        )
    }

    func testWaitingForMeWinsOverMonitor() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .waiting, isMonitorSession: true)),
            .waitingForMe
        )
    }

    func testParallelAgentsWinsOverMonitor() {
        // A fan-out parent that also ran Monitor still reads as parallelAgents
        // — "running sub-agents" is the more salient fact.
        XCTAssertEqual(
            SessionDisplayStatus.derive(
                from: session(agentState: .blocked, isMonitorSession: true),
                hasActiveChildren: true
            ),
            .parallelAgents
        )
    }

    func testEndedWinsOverMonitor() {
        XCTAssertEqual(
            SessionDisplayStatus.derive(from: session(agentState: .blocked, endedAt: Date(), isMonitorSession: true)),
            .stale
        )
    }
}
