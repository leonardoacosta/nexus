// PayloadDecodeTests v2 — pin the Swift Codable models against canonical
// agent JSON payloads so a wire-format drift fails Tier A at the gate.
//
// Spec: openspec/changes/agent-payload-completeness
//       (replaces v1 from extend-integration-gate-liveness-payloads)
//
// What changed from v1:
//   - ProjectAggregate fixtures now include `hidden` and the positive
//     test asserts the non-optional Bool decodes correctly.
//   - SpecSummary fixtures include `has_proposal`/`has_design`/`has_tasks`
//     and assert the tri-state surfaces.
//   - NotificationEvent fixtures include `severity` + `delivery_state`
//     and assert the typed enum decode.
//   - ScriptError (`top_errors[]`) fixtures include `trace_id` and
//     `stack_truncated`; the legacy-row scenario asserts a nullable
//     `trace_id` tolerates a JSON null without throwing.
//   - Four NEGATIVE tests prove the gate's selectivity: hidden-omitted
//     decodes to false (tolerance), markers-omitted decode to false,
//     unknown severity FAILS decode, stack_truncated default false.
//
// Fixtures are inline string literals. They are hand-crafted to match
// the contract emitted by the agent at commit f6d0e05 (the latest API
// batch commit on main). The live homelab agent will not surface the
// new fields until that commit deploys, so these fixtures cannot be
// captured from `curl` until the deploy lands. Updating the agent's
// payload requires updating the fixture here, which makes the wire
// contract change visible in the diff.

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

    // MARK: - ProjectAggregate (v2: + hidden)

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testProjectAggregateDecodesWithHidden() throws {
        let json = """
        {
            "name": "nexus",
            "active_sessions": 2,
            "total_sessions": 5,
            "machines": ["homelab", "macbook"],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-aaaaaaaaaaaa",
            "hidden": false
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNotNil(p.projectID, "registered project rows ship `id` non-nil")
        XCTAssertEqual(p.name, "nexus")
        XCTAssertGreaterThan(p.totalSessions, 0)
        XCTAssertEqual(p.machines, ["homelab", "macbook"])
        XCTAssertFalse(p.hidden, "visible registry row decodes hidden=false")
    }

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testProjectAggregateDecodesHiddenTrue() throws {
        let json = """
        {
            "name": "stealth-project",
            "active_sessions": 0,
            "total_sessions": 3,
            "machines": ["homelab"],
            "id": "1a2b3c4d-5e6f-7890-abcd-ef0123456789",
            "hidden": true
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertTrue(p.hidden, "hidden registry row decodes hidden=true")
    }

    func testProjectAggregateSessionOnlyBucketHasNilId() throws {
        // The unregistered bucket sends id=null AND hidden=false.
        // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
        let json = """
        {
            "name": "(unregistered)",
            "active_sessions": 0,
            "total_sessions": 1,
            "machines": ["macbook"],
            "id": null,
            "hidden": false
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNil(p.projectID)
        XCTAssertEqual(p.name, "(unregistered)")
        XCTAssertFalse(p.hidden, "unregistered bucket always hidden=false")
    }

    // Negative test 1/4: older agents that omit `hidden` decode tolerantly
    // (default = false). This proves backward compatibility, NOT a hard
    // gate failure — `hidden` is treated as a soft field for the deploy
    // window. The hard gate is on severity (see notification test).
    func testProjectAggregateDecodeToleratesOmittedHidden() throws {
        let json = """
        {
            "name": "legacy-project",
            "active_sessions": 1,
            "total_sessions": 2,
            "machines": ["homelab"],
            "id": "deadbeef-1234-5678-9abc-def012345678"
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertFalse(p.hidden, "omitted hidden defaults to false (legacy-agent tolerance)")
    }

    // MARK: - ProjectAggregate.gitMetadata (projects-tab-accordion-deeplink)

    // Contract: projects-tab-accordion-deeplink spec 2026-05-21 § project-registry.
    // Wire-format round-trip: agent emits non-null git_metadata object on a
    // tracked branch; Swift decoder populates `gitMetadata` with branch +
    // ahead/behind/dirty + lastCommit.
    func testProjectAggregateDecodesGitMetadataPresent() throws {
        let json = """
        {
            "name": "nx",
            "active_sessions": 2,
            "total_sessions": 5,
            "machines": ["homelab"],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-aaaaaaaaaaaa",
            "hidden": false,
            "git_metadata": {
                "branch": "main",
                "ahead": 0,
                "behind": 0,
                "dirty": false,
                "last_commit": {
                    "author": "leo",
                    "ts": "2026-05-21T18:00:00-05:00"
                }
            }
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNotNil(p.gitMetadata)
        XCTAssertEqual(p.gitMetadata?.branch, "main")
        XCTAssertEqual(p.gitMetadata?.ahead, 0)
        XCTAssertEqual(p.gitMetadata?.behind, 0)
        XCTAssertFalse(p.gitMetadata?.dirty ?? true)
        XCTAssertEqual(p.gitMetadata?.lastCommit?.author, "leo")
        XCTAssertNotNil(p.gitMetadata?.lastCommit?.ts)
    }

    // Contract: dirty branch on feat/foo ahead of origin.
    func testProjectAggregateDecodesGitMetadataDirtyBranch() throws {
        let json = """
        {
            "name": "nx",
            "active_sessions": 1,
            "total_sessions": 1,
            "machines": ["homelab"],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-aaaaaaaaaaaa",
            "hidden": false,
            "git_metadata": {
                "branch": "feat/foo",
                "ahead": 3,
                "behind": 0,
                "dirty": true,
                "last_commit": {
                    "author": "leo",
                    "ts": "2026-05-21T18:00:00-05:00"
                }
            }
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertEqual(p.gitMetadata?.branch, "feat/foo")
        XCTAssertEqual(p.gitMetadata?.ahead, 3)
        XCTAssertTrue(p.gitMetadata?.dirty ?? false)
    }

    // Contract: detached HEAD — non-nil git_metadata, nil branch.
    func testProjectAggregateDecodesGitMetadataDetachedHead() throws {
        let json = """
        {
            "name": "nx",
            "active_sessions": 0,
            "total_sessions": 0,
            "machines": [],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-aaaaaaaaaaaa",
            "hidden": false,
            "git_metadata": {
                "branch": null,
                "ahead": 0,
                "behind": 0,
                "dirty": false,
                "last_commit": {
                    "author": "leo",
                    "ts": "2026-05-21T18:00:00-05:00"
                }
            }
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNotNil(p.gitMetadata, "detached HEAD still emits the object")
        XCTAssertNil(p.gitMetadata?.branch, "branch is null for detached HEAD")
    }

    // Contract: non-git directory — git_metadata is explicit JSON null,
    // decoder collapses to nil.
    func testProjectAggregateDecodesGitMetadataNullForNonGit() throws {
        let json = """
        {
            "name": "notes",
            "active_sessions": 0,
            "total_sessions": 0,
            "machines": ["homelab"],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-bbbbbbbbbbbb",
            "hidden": false,
            "git_metadata": null
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNil(p.gitMetadata, "non-git cwd surfaces gitMetadata=nil")
    }

    // Contract: legacy agent that pre-dates projects-tab-accordion-deeplink
    // omits the field entirely. Decoder MUST tolerate it without throwing.
    func testProjectAggregateDecodesToleratesOmittedGitMetadata() throws {
        let json = """
        {
            "name": "nx",
            "active_sessions": 2,
            "total_sessions": 5,
            "machines": ["homelab"],
            "id": "0f7c8a1e-2b9d-4c3a-9e1f-aaaaaaaaaaaa",
            "hidden": false
        }
        """
        let p = try decode(ProjectAggregate.self, from: json)
        XCTAssertNil(p.gitMetadata)
    }

    // Contract: round-trip encode-then-decode preserves the structure
    // (proves the CodingKeys + Date encoder/decoder are inverse).
    func testGitMetadataRoundTripsEncode() throws {
        let commit = GitMetadata.Commit(
            author: "leo",
            ts: ISO8601DateFormatter().date(from: "2026-05-21T18:00:00Z")!
        )
        let md = GitMetadata(
            branch: "main",
            ahead: 1,
            behind: 2,
            dirty: true,
            lastCommit: commit
        )
        let data = try JSONEncoder().encode(md)
        let decoded = try JSONDecoder().decode(GitMetadata.self, from: data)
        XCTAssertEqual(decoded, md)
    }

    // MARK: - CredentialState (unchanged from v1)

    func testCredentialStateDecodes() throws {
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
        XCTAssertGreaterThanOrEqual(env.credentials.count, 1)
        XCTAssertEqual(env.activeFingerprint, "fp-aaaa")
        let active = env.credentials.first { $0.fingerprint == env.activeFingerprint }
        XCTAssertNotNil(active)
        XCTAssertEqual(active?.status, "active")
        let rateLimited = env.credentials.first { $0.status == "rate-limited" }
        XCTAssertNotNil(rateLimited)
        XCTAssertEqual(rateLimited?.rateLimit429Count, 3)
    }

    // MARK: - SpecSummary (v2: + has_proposal/has_design/has_tasks)

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testSpecSummaryDecodesWithMarkers() throws {
        let json = """
        {
            "name": "agent-payload-completeness",
            "project": "nx",
            "status": "in-progress",
            "completedTasks": 9,
            "totalTasks": 19,
            "lastModified": "2026-05-19T10:00:00.000Z",
            "has_proposal": true,
            "has_design": true,
            "has_tasks": true
        }
        """
        let s = try decode(SpecSummary.self, from: json)
        XCTAssertEqual(s.name, "agent-payload-completeness")
        XCTAssertEqual(s.project, "nx")
        XCTAssertEqual(s.status, "in-progress")
        XCTAssertEqual(s.completedTasks, 9)
        XCTAssertEqual(s.totalTasks, 19)
        XCTAssertTrue(s.hasProposal, "complete spec has proposal.md")
        XCTAssertTrue(s.hasDesign, "complete spec has design.md")
        XCTAssertTrue(s.hasTasks, "complete spec has tasks.md")
        XCTAssertNotNil(s.lastModified)
    }

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testSpecSummaryDecodesProposalOnlyTriState() throws {
        // Proposal-only spec — design.md + tasks.md absent on disk.
        let json = """
        {
            "name": "early-spec",
            "project": "nx",
            "status": "draft",
            "completedTasks": 0,
            "totalTasks": 0,
            "lastModified": "2026-05-18T08:00:00.000Z",
            "has_proposal": true,
            "has_design": false,
            "has_tasks": false
        }
        """
        let s = try decode(SpecSummary.self, from: json)
        XCTAssertTrue(s.hasProposal)
        XCTAssertFalse(s.hasDesign, "design.md absent decodes to false")
        XCTAssertFalse(s.hasTasks, "tasks.md absent decodes to false")
    }

    // Negative test 2/4: older agents that omit the marker tri-state
    // decode tolerantly (all default = false). The v2 gate would catch
    // a regression only when the agent affirmatively emits a malformed
    // value — omission is treated as legacy-agent tolerance.
    func testSpecSummaryDecodeToleratesOmittedMarkers() throws {
        let json = """
        {
            "name": "no-markers-spec",
            "project": "nx",
            "status": "draft"
        }
        """
        let s = try decode(SpecSummary.self, from: json)
        XCTAssertFalse(s.hasProposal, "omitted has_proposal defaults to false")
        XCTAssertFalse(s.hasDesign, "omitted has_design defaults to false")
        XCTAssertFalse(s.hasTasks, "omitted has_tasks defaults to false")
        XCTAssertEqual(s.completedTasks, 0)
        XCTAssertEqual(s.totalTasks, 0)
    }

    // MARK: - NotificationEvent (v2: + severity + delivery_state)

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testNotificationDecodesWithSeverityAndDeliveryState() throws {
        let json = """
        {
            "id": "B40A2C20-9E0E-4F49-A1B5-1A0BAEFEFEFE",
            "title": "Nexus",
            "body": "Stop hook fired for session abc123",
            "channel": "tts",
            "project": "nx",
            "severity": "warn",
            "delivery_state": "delivered",
            "created_at": "2026-05-19T10:00:00.000Z"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(n.body, "Stop hook fired for session abc123")
        XCTAssertEqual(n.channel, "tts")
        XCTAssertEqual(n.title, "Nexus")
        XCTAssertEqual(n.project, "nx")
        XCTAssertEqual(n.severity, .warn, "severity decodes to typed enum case")
        XCTAssertEqual(n.deliveryState, .delivered, "delivery_state decodes to typed enum case")
        XCTAssertEqual(
            n.id.uuidString.lowercased(),
            "B40A2C20-9E0E-4F49-A1B5-1A0BAEFEFEFE".lowercased(),
            "id MUST decode preserving the wire UUID"
        )
    }

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testNotificationDecodesErrorSeverityFailedDelivery() throws {
        let json = """
        {
            "id": "11111111-2222-3333-4444-555555555555",
            "title": "TTS unreachable",
            "body": "ElevenLabs rate-limit exhausted",
            "channel": "tts",
            "project": null,
            "severity": "error",
            "delivery_state": "failed",
            "created_at": "2026-05-19T11:00:00.000Z"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(n.severity, .error)
        XCTAssertEqual(n.deliveryState, .failed)
        XCTAssertNil(n.project, "null project decodes to nil")
    }

    // Negative test 3/4: UNKNOWN severity value MUST fail decode. This
    // is the gate's primary selectivity proof — a payload outside the
    // documented enum aborts the pre-push gate with a Codable error.
    func testNotificationDecodeFailsOnUnknownSeverity() {
        let json = """
        {
            "id": "DEADBEEF-DEAD-BEEF-DEAD-BEEFDEADBEEF",
            "title": "Bad payload",
            "body": "agent emitted out-of-contract severity",
            "channel": "tts",
            "project": "nx",
            "severity": "critical",
            "delivery_state": "delivered",
            "created_at": "2026-05-19T12:00:00.000Z"
        }
        """
        XCTAssertThrowsError(try decode(NotificationEvent.self, from: json)) { error in
            // Codable raises DecodingError.dataCorrupted for unknown enum
            // raw values; assert the error surfaces so the gate can
            // surface the offending key in the failure tail.
            guard let decodingError = error as? DecodingError else {
                XCTFail("Expected DecodingError for unknown enum value, got \(error)")
                return
            }
            switch decodingError {
            case .dataCorrupted, .typeMismatch, .valueNotFound, .keyNotFound:
                // Any DecodingError variant is acceptable — what matters
                // is the decode aborted rather than silently degraded.
                break
            @unknown default:
                XCTFail("Unexpected DecodingError variant: \(decodingError)")
            }
        }
    }

    // Tolerance check: an older agent that omits severity/delivery_state
    // entirely decodes to the safe defaults. This contrasts with the
    // strict-on-unknown-enum-value check above.
    func testNotificationDecodeToleratesOmittedSeverityFields() throws {
        let json = """
        {
            "id": "F0F0F0F0-F0F0-F0F0-F0F0-F0F0F0F0F0F0",
            "title": "Legacy emission",
            "body": "agent without severity contract",
            "channel": "tts",
            "created_at": "2026-05-19T13:00:00.000Z"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(n.severity, .info, "omitted severity defaults to .info")
        XCTAssertEqual(n.deliveryState, .pending, "omitted delivery_state defaults to .pending")
    }

    // MARK: - FailureRecord / ScriptError (v2: + trace_id + stack_truncated)

    // Contract: agent-payload-completeness spec 2026-05-19, agent commit f6d0e05
    func testFailureRecordDecodesWithTraceIDAndStackTruncated() throws {
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
                    "occurrences": 7,
                    "trace_id": "00f067aa0ba902b7-aaaaaaaaaaaaaaaa",
                    "stack_truncated": true
                },
                {
                    "id": "err-2",
                    "script": "scripts.cleanup-tmux",
                    "message": "no such session",
                    "captured_at": 1747504800000,
                    "occurrences": 1,
                    "trace_id": null,
                    "stack_truncated": false
                }
            ]
        }
        """
        let env = try decode(FailuresResponse.self, from: json)
        XCTAssertEqual(env.periodDays, 7)
        XCTAssertEqual(env.total, 42)
        XCTAssertEqual(env.topErrors.count, 2)

        let first = env.topErrors[0]
        XCTAssertEqual(first.id, "err-1")
        XCTAssertEqual(first.script, "notifications.tts.elevenlabs")
        XCTAssertEqual(first.occurrences, 7)
        XCTAssertNotNil(first.stack)
        XCTAssertNotNil(first.source)
        XCTAssertEqual(
            first.traceID,
            "00f067aa0ba902b7-aaaaaaaaaaaaaaaa",
            "instrumented row carries non-nil trace_id"
        )
        XCTAssertTrue(first.stackTruncated, "row above truncation threshold flags truncated=true")

        let second = env.topErrors[1]
        XCTAssertGreaterThan(second.capturedAt.timeIntervalSince1970, 0)
        XCTAssertEqual(second.occurrences, 1)
        XCTAssertNil(second.traceID, "legacy row decodes JSON null trace_id to nil without throwing")
        XCTAssertFalse(second.stackTruncated, "non-truncated row flags false")
    }

    // Negative test 4/4: older agents that omit `stack_truncated` decode
    // tolerantly (default = false). Older agents that omit `trace_id`
    // decode to nil (Optional<String>). Neither raises a decode error —
    // legacy-row tolerance is intentional per the spec scenario.
    func testFailureRecordDecodeToleratesOmittedTraceAndTruncation() throws {
        let json = """
        {
            "period_days": 7,
            "total": 1,
            "top_errors": [
                {
                    "id": "legacy-err",
                    "script": "scripts.legacy",
                    "message": "pre-instrumentation row",
                    "captured_at": "2026-04-01T00:00:00.000Z",
                    "occurrences": 1
                }
            ]
        }
        """
        let env = try decode(FailuresResponse.self, from: json)
        let row = env.topErrors[0]
        XCTAssertNil(row.traceID, "omitted trace_id decodes to nil")
        XCTAssertFalse(row.stackTruncated, "omitted stack_truncated defaults to false")
    }

    // MARK: - HealthMetrics (unchanged from v1 — task 2.1 safe defaults)

    func testHealthMetricsDecodesOlderAgentWithoutLivenessFields() throws {
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
