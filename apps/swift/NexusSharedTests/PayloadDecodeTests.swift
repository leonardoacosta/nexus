// PayloadDecodeTests — pin the Swift Codable models against canonical
// agent JSON payloads so a wire-format drift fails Tier A at the gate.
//
// Spec: openspec/changes/extend-integration-gate-liveness-payloads
//       (tasks 2.2 - 2.8)
//
// Fixtures are inline string literals captured against the agent's REST
// surface (`GET /projects`, `/credentials`, `/specs`, `/notifications`,
// `/failures`). They are decode-only — no HTTP, no fixture-server, no
// race. Updating the agent's payload requires updating the fixture here,
// which makes the wire contract change visible in the diff.
//
// Notes on spec-vs-model divergence:
//   - ProjectAggregate has no `hidden` field today. Spec's `hidden == false`
//     assertion is deferred until the field lands; we still assert the
//     present-day contract (id non-nil, session counts > 0).
//   - SpecSummary today carries name/project/status/{completed,total}Tasks
//     and lacks the hasProposal/hasDesign/hasTasks tri-state in the spec
//     prose. We assert the present-day contract.
//   - NotificationEvent today has no severity / deliveryState fields. We
//     assert decode of body/title/channel and document the gap.
//   - ScriptError today has no trace_id or stack_truncated columns. We
//     assert id/script/message/occurrences and document the gap.
//
// When the agent grows these fields, extend the inline JSON + the
// assertion list — the test class is the single place to ratchet.

import XCTest
@testable import NexusShared

final class PayloadDecodeTests: XCTestCase {

    // MARK: - Decoder helper

    /// Decode `T` from an inline JSON string. Uses a plain decoder — the
    /// individual model `init(from:)` implementations own snake-case
    /// mapping via `CodingKeys`, matching the production decode path in
    /// `NexusClient`. We do NOT set `keyDecodingStrategy = .convertFromSnakeCase`
    /// here because several models (`HealthSnapshot`, `ScriptError`,
    /// `HealthMetrics`) mix explicit camelCase fields with explicit
    /// snake_case `CodingKeys` and the global strategy would corrupt them.
    private func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(type, from: data)
    }

    // MARK: - 2.3 ProjectAggregate

    func testProjectAggregateDecodes() throws {
        // Canonical row from `GET /projects` — matches the envelope shape
        // in apps/agent/src/routes/projects.ts.
        let json = """
        {
            "name": "nexus",
            "active_sessions": 2,
            "total_sessions": 5,
            "machines": ["homelab", "macbook"],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-aaaaaaaaaaaa"
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNotNil(p.projectID, "registered project rows ship `id` non-nil")
        XCTAssertEqual(p.name, "nexus")
        XCTAssertGreaterThan(p.totalSessions, 0, "fixture row has sessionCount > 0")
        XCTAssertEqual(p.machines, ["homelab", "macbook"])
        // `hidden` is not in the model today — spec assertion deferred.
    }

    func testProjectAggregateSessionOnlyBucketHasNilId() throws {
        // Older agents (and the `(unregistered)` fallback) ship `id: null`.
        // Decoder MUST tolerate this without throwing.
        let json = """
        {
            "name": "(unregistered)",
            "active_sessions": 0,
            "total_sessions": 1,
            "machines": ["macbook"],
            "id": null
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNil(p.projectID)
        XCTAssertEqual(p.name, "(unregistered)")
    }

    // MARK: - 2.4 CredentialState

    func testCredentialStateDecodes() throws {
        // Canonical envelope from `GET /credentials` — wraps the profile
        // list plus the currently-active fingerprint so the dashboard can
        // flag the live row.
        let json = """
        {
            "credentials": [
                {
                    "id": "prof-1",
                    "name": "personal",
                    "fingerprint": "fp-aaaa",
                    "subscriptionType": "Pro",
                    "rateLimitTier": "default",
                    "accountEmail": "leo@example.com",
                    "accountName": "Leo",
                    "orgName": null,
                    "status": "active",
                    "expiresAt": "2026-12-01T00:00:00.000Z",
                    "rateLimit429Count": 0,
                    "lastSwapAt": null,
                    "isActive": true
                },
                {
                    "id": "prof-2",
                    "name": "work",
                    "fingerprint": "fp-bbbb",
                    "status": "rate-limited",
                    "rateLimit429Count": 3,
                    "isActive": false
                }
            ],
            "activeFingerprint": "fp-aaaa"
        }
        """
        let env = try decode(CredentialListResponse.self, from: json)
        XCTAssertGreaterThanOrEqual(env.credentials.count, 1,
                                    "/credentials envelope MUST carry at least one provider")
        XCTAssertEqual(env.activeFingerprint, "fp-aaaa")
        let active = env.credentials.first { $0.fingerprint == env.activeFingerprint }
        XCTAssertNotNil(active, "activeFingerprint MUST resolve to one of the listed credentials")
        XCTAssertEqual(active?.status, "active",
                       "expected state enum value 'active' decodes off the string field")
        let rateLimited = env.credentials.first { $0.status == "rate-limited" }
        XCTAssertNotNil(rateLimited, "alternate 'rate-limited' status decodes")
        XCTAssertEqual(rateLimited?.rateLimit429Count, 3)
    }

    // MARK: - 2.5 SpecMeta

    func testSpecMetaDecodes() throws {
        // Canonical row from `GET /specs` — apps/agent/src/routes/specs.ts.
        // The agent's wire shape today does NOT carry a hasProposal /
        // hasDesign / hasTasks tri-state; the spec prose anticipates a
        // future extension. We assert the present-day contract: name,
        // project, status, task counts decode, and a non-empty
        // capability-style slug is derivable from `name`.
        let json = """
        {
            "name": "extend-integration-gate-liveness-payloads",
            "project": "nx",
            "status": "in-progress",
            "completedTasks": 8,
            "totalTasks": 20,
            "lastModified": "2026-05-19T10:00:00.000Z"
        }
        """
        let s = try decode(SpecSummary.self, from: json)
        XCTAssertEqual(s.name, "extend-integration-gate-liveness-payloads")
        XCTAssertEqual(s.project, "nx")
        XCTAssertEqual(s.status, "in-progress")
        XCTAssertEqual(s.completedTasks, 8)
        XCTAssertEqual(s.totalTasks, 20)
        XCTAssertFalse(s.name.isEmpty, "spec slug MUST be non-empty")
        XCTAssertGreaterThan(s.progress, 0, "progress derived from {completed,total}Tasks")
        XCTAssertLessThan(s.progress, 1)
        XCTAssertNotNil(s.lastModified)
    }

    func testSpecMetaToleratesMissingTaskCounts() throws {
        // Older agents may omit task counts entirely — model defaults to 0.
        let json = """
        {
            "name": "early-spec",
            "project": "nx",
            "status": "draft"
        }
        """
        let s = try decode(SpecSummary.self, from: json)
        XCTAssertEqual(s.completedTasks, 0)
        XCTAssertEqual(s.totalTasks, 0)
        XCTAssertEqual(s.progress, 0)
    }

    // MARK: - 2.6 Notification

    func testNotificationDecodes() throws {
        // Canonical payload from the agent's `NotificationFired` event /
        // `/notifications` REST surface. The Swift model today carries
        // body/title/channel/emoji + receivedAt; severity + delivery
        // state are not yet typed on the Swift side.
        let json = """
        {
            "id": "B40A2C20-9E0E-4F49-A1B5-1A0BAEFEFEFE",
            "body": "Stop hook fired for session abc123",
            "channel": "elevenlabs",
            "title": "Nexus",
            "emoji": "bell",
            "receivedAt": 1747504800
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(n.body, "Stop hook fired for session abc123")
        XCTAssertEqual(n.channel, "elevenlabs",
                       "channel acts as the delivery-state lane today")
        XCTAssertEqual(n.title, "Nexus")
        XCTAssertEqual(n.emoji, "bell")
        XCTAssertNotNil(n.id, "id MUST decode to a non-nil UUID")
    }

    // MARK: - 2.7 FailureRecord

    func testFailureRecordDecodes() throws {
        // Canonical envelope from `GET /failures` — wraps `top_errors`,
        // the aggregated array the dashboard renders directly. ScriptError
        // does NOT carry trace_id or stack_truncated today; those spec
        // assertions are deferred until the schema grows the columns.
        let json = """
        {
            "period_days": 7,
            "total": 42,
            "top_errors": [
                {
                    "id": "err-1",
                    "script": "notifications.tts.elevenlabs",
                    "message": "429 too many requests",
                    "captured_at": "2026-05-18T12:00:00.000Z",
                    "stack": "Error: 429\\n  at fetch (...)",
                    "source": "notifications.tts",
                    "occurrences": 7
                },
                {
                    "id": "err-2",
                    "script": "scripts.cleanup-tmux",
                    "message": "no such session",
                    "captured_at": 1747504800000,
                    "occurrences": 1
                }
            ]
        }
        """
        let env = try decode(FailuresResponse.self, from: json)
        XCTAssertEqual(env.periodDays, 7)
        XCTAssertEqual(env.total, 42)
        XCTAssertEqual(env.topErrors.count, 2,
                       "top_errors MUST decode every row")

        let first = env.topErrors[0]
        XCTAssertEqual(first.id, "err-1",
                       "id acts as the dashboard's row identity (trace_id proxy today)")
        XCTAssertFalse(first.id.isEmpty, "id MUST be non-empty (trace_id non-nil proxy)")
        XCTAssertEqual(first.script, "notifications.tts.elevenlabs")
        XCTAssertEqual(first.occurrences, 7)
        XCTAssertNotNil(first.stack)
        XCTAssertNotNil(first.source)

        let second = env.topErrors[1]
        // Epoch-millis date decodes through the permissive helper.
        XCTAssertGreaterThan(second.capturedAt.timeIntervalSince1970, 0)
        XCTAssertEqual(second.occurrences, 1,
                       "occurrences default = 1 when omitted-or-present-as-1")
    }

    // MARK: - HealthMetrics (task 2.1 — safe defaults)

    func testHealthMetricsDecodesOlderAgentWithoutLivenessFields() throws {
        // Older agent omits db_ok / last_watcher_tick_ms / socket_server_listening.
        // Decoder MUST apply safe defaults so the dashboard can still bind.
        let json = """
        {
            "hostname": "homelab",
            "uptime_seconds": 12345.6,
            "cpu": { "overall_percent": 12.5, "per_core_percent": [10, 15], "load_average": [0.5, 0.6, 0.7] },
            "ram": { "total_bytes": 17179869184, "used_bytes": 8589934592, "percent": 50.0 },
            "disk": [],
            "docker": null
        }
        """
        let h = try decode(HealthMetrics.self, from: json)
        XCTAssertEqual(h.hostname, "homelab")
        XCTAssertEqual(h.dbOk, false, "missing db_ok defaults to false (not 'unknown true')")
        XCTAssertEqual(h.lastWatcherTickMs, -1, "missing tick defaults to -1 sentinel")
        XCTAssertEqual(h.socketServerListening, false, "missing socket flag defaults to false")
    }

    func testHealthMetricsDecodesNewAgentWithLivenessFields() throws {
        let json = """
        {
            "hostname": "homelab",
            "uptime_seconds": 12345.6,
            "cpu": { "overall_percent": 12.5, "per_core_percent": [10, 15], "load_average": [0.5, 0.6, 0.7] },
            "ram": { "total_bytes": 17179869184, "used_bytes": 8589934592, "percent": 50.0 },
            "disk": [],
            "docker": { "containers": 7, "running": 5 },
            "db_ok": true,
            "last_watcher_tick_ms": 1234,
            "socket_server_listening": true
        }
        """
        let h = try decode(HealthMetrics.self, from: json)
        XCTAssertTrue(h.dbOk)
        XCTAssertEqual(h.lastWatcherTickMs, 1234)
        XCTAssertTrue(h.socketServerListening)
        XCTAssertEqual(h.docker?.running, 5)
    }
}
