//
//  SSEEventParsingTests.swift
//  nexusTests
//
//  Feeds fixture SSE byte streams for all 5 event types and asserts the
//  decoder produces the expected payloads. The decoder is `SSEEvent.decode*`
//  on `NexusShared.SSEEvent` (post nx-4roof migration); the stream consumer
//  (`SSEDecoder.consume`) is exercised indirectly here.
//

import XCTest
import NexusShared
@testable import nexus

final class SSEEventParsingTests: XCTestCase {

    func testDecodeRemoteSessionStartedFromNestedEnvelope() {
        let json = """
        {"event":"RemoteSessionStarted","timestamp":"2026-05-16T11:00:00Z","payload":{"session":{"id":"s-1","project":"nx","machine":"homelab","agent":"homelab","status":"active","startedAt":"2026-05-16T11:00:00Z","lastHeartbeat":"2026-05-16T11:00:00Z"}}}
        """
        let event = SSEEvent(name: "RemoteSessionStarted", data: json)
        let session = event.decodeSession()
        XCTAssertNotNil(session)
        XCTAssertEqual(session?.id, "s-1")
        XCTAssertEqual(session?.project, "nx")
        XCTAssertEqual(session?.originAgent, "homelab")
    }

    func testDecodeRemoteSessionEndedSessionId() {
        let json = #"{"event":"RemoteSessionEnded","sessionId":"s-1"}"#
        let event = SSEEvent(name: "RemoteSessionEnded", data: json)
        XCTAssertEqual(event.decodeSessionId(), "s-1")
    }

    func testDecodeHomelabHeartbeatMetrics() {
        let json = #"{"event":"HomelabHeartbeat","cpu_percent":42.5,"ram_percent":71.3}"#
        let event = SSEEvent(name: "HomelabHeartbeat", data: json)
        let (cpu, ram) = event.decodeHeartbeatMetrics()
        XCTAssertEqual(cpu, 42.5)
        XCTAssertEqual(ram, 71.3)
    }

    func testDecodePeerLostIsHandled() {
        // PeerLost carries no payload — the parser shouldn't crash on it.
        let json = #"{"event":"PeerLost","peer":"homelab"}"#
        let event = SSEEvent(name: "PeerLost", data: json)
        // No structural assertion; we only verify decode doesn't throw.
        XCTAssertNil(event.decodeSession())
    }

    func testDecodeNotificationFiredBody() {
        let json = #"{"event":"NotificationFired","payload":{"body":"build done","channel":"tts","title":"nx"}}"#
        let event = SSEEvent(name: "NotificationFired", data: json)
        let ev = event.decodeNotification()
        XCTAssertNotNil(ev)
        XCTAssertEqual(ev?.body, "build done")
        XCTAssertEqual(ev?.channel, "tts")
        XCTAssertEqual(ev?.title, "nx")
    }

    func testIntegrationViaNexusClientActorMutation() async throws {
        // Wire an actor + view model and assert that hand-feeding 3 events
        // produces the expected state. Verifies the actor->view-model bridge.
        let store = NotificationStore(suiteName: "com.nexus.menubar.tests")
        store.reset()
        let client = NexusClient(store: store)

        // 1. RemoteSessionStarted — adds a *real* Claude Code session.
        // `homelabSessions()` (the session-count input to AggregateState
        // .derive) deliberately excludes telemetry-ping stubs that lack a CC
        // fingerprint (pid/tmuxTarget/cwd/ccSessionId/model) — see
        // NexusClient.homelabSessions() and the fix-agent-cc-session-tracking
        // spec. A fingerprint-less row would yield .idle, not .active. Stamp a
        // pid so the row represents an actual running CC process, which is the
        // precise condition `.active` encodes ("reachable AND >= 1 real
        // session running").
        let s = NexusSession(id: "x", project: "nx", machine: "homelab",
                             agent: "homelab", status: "active", pid: 4242)
        await client.upsertSession(s)

        // 2. NotificationFired — prepends one
        await client.prependNotification(NotificationEvent(body: "hi"))

        // 3. HomelabHeartbeat — sets reachability
        await client.recordHeartbeat(at: Date(), cpu: 10, ram: 20)

        let snap = await client.snapshot()
        XCTAssertEqual(snap.sessions.count, 1)
        XCTAssertEqual(snap.notifications.count, 1)
        XCTAssertEqual(snap.notifications.first?.body, "hi")
        XCTAssertEqual(snap.aggregateState, .active)
    }
}
