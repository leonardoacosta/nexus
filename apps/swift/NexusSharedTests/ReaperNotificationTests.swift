// ReaperNotificationTests — pin the wire + render + activation seams
// added by openspec/changes/adopt-reaper-into-nx-cron (UI batch 3.1–3.4).
//
// Covers:
//   1. NotificationEvent decodes `items` + `log_path` (and the camelCase
//      `logPath` legacy fallback) without breaking back-compat for older
//      payloads that omit both fields.
//   2. TTSObserver.renderBody expands a non-empty `items` array into a
//      `• line` bullet list appended to `event.body`; nil/empty `items`
//      degrades cleanly to `event.body`.
//   3. NotificationActivation routes a non-empty `logPath` userInfo entry
//      to `.openFile(URL)`; absent / empty / non-string entries route to
//      `.defaultActivation`.
//
// The macOS AppKit `NotificationActivationHandler` (which closes the
// loop on `NSWorkspace.shared.open(_:)`) is covered in
// `nexus-mac/Tests/NotificationActivationHandlerTests.swift` — that
// surface needs AppKit and lives in the host-bundled target.

import XCTest
@testable import NexusShared

final class ReaperNotificationTests: XCTestCase {

    // MARK: - Decoder helper (mirrors PayloadDecodeTests convention)

    private func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(type, from: data)
    }

    // MARK: - 3.1 — wire contract

    /// A reaper-completion payload carries both fields; both decode.
    func testNotificationDecodesItemsAndLogPath() throws {
        let json = """
        {
            "id": "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
            "title": "Weekly reaper",
            "body": "Cleaned 4.2 GB across 12 caches.",
            "channel": "tts",
            "project": "nx",
            "severity": "info",
            "delivery_state": "delivered",
            "created_at": "2026-05-21T03:00:00.000Z",
            "items": [
                "node_modules/.cache 1.8 GB",
                ".turbo 1.1 GB",
                ".next 800 MB"
            ],
            "log_path": "/Users/leonardoacosta/.local/share/nexus/reaper/2026-05-21.log"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(n.items?.count, 3, "items decodes as a 3-element array")
        XCTAssertEqual(n.items?.first, "node_modules/.cache 1.8 GB")
        XCTAssertEqual(
            n.logPath,
            "/Users/leonardoacosta/.local/share/nexus/reaper/2026-05-21.log",
            "log_path decodes from canonical snake_case key"
        )
    }

    /// Legacy camelCase `logPath` spelling is tolerated on decode (the
    /// agent's SSE bridge sometimes camelCases keys); canonical encode
    /// path emits snake_case.
    func testNotificationDecodesLogPathCamelCaseFallback() throws {
        let json = """
        {
            "id": "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
            "title": "Weekly reaper",
            "body": "Cleaned",
            "channel": "tts",
            "severity": "info",
            "delivery_state": "delivered",
            "created_at": "2026-05-21T03:00:00.000Z",
            "logPath": "/tmp/reaper.log"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(
            n.logPath, "/tmp/reaper.log",
            "camelCase logPath is accepted as a legacy fallback key"
        )
    }

    /// Back-compat: older agents that emit no items / logPath still decode.
    /// This is the regression check that prevents a Codable break.
    func testNotificationDecodesWithoutItemsOrLogPath() throws {
        let json = """
        {
            "id": "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
            "title": "Legacy",
            "body": "older agent without structured fields",
            "channel": "tts",
            "severity": "info",
            "delivery_state": "delivered",
            "created_at": "2026-05-21T03:00:00.000Z"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertNil(n.items, "absent items key decodes as nil")
        XCTAssertNil(n.logPath, "absent log_path key decodes as nil")
    }

    /// Encode round-trip preserves the structured fields on canonical keys.
    func testNotificationRoundTripsItemsAndLogPath() throws {
        let event = NotificationEvent(
            body: "Cleaned",
            channel: "tts",
            title: "Weekly reaper",
            project: "nx",
            items: ["a", "b"],
            logPath: "/tmp/reaper.log"
        )
        let encoded = try JSONEncoder().encode(event)
        let roundtrip = try JSONDecoder().decode(NotificationEvent.self, from: encoded)
        XCTAssertEqual(roundtrip.items, ["a", "b"])
        XCTAssertEqual(roundtrip.logPath, "/tmp/reaper.log")

        // Sanity-check the canonical wire spelling.
        let wire = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertTrue(wire.contains("\"log_path\""), "encodes log_path (snake_case)")
        XCTAssertFalse(wire.contains("\"logPath\""), "does NOT emit legacy camelCase spelling")
    }

    // MARK: - 3.2 — bullet rendering

    /// Non-empty items expands into bullet list appended to body.
    func testRenderBodyExpandsItemsAsBulletList() {
        let event = NotificationEvent(
            body: "Cleaned 4.2 GB across 12 caches.",
            channel: "tts",
            items: ["node_modules/.cache 1.8 GB", ".turbo 1.1 GB"]
        )
        let body = TTSObserver.renderBody(for: event)
        XCTAssertEqual(
            body,
            """
            Cleaned 4.2 GB across 12 caches.

            • node_modules/.cache 1.8 GB
            • .turbo 1.1 GB
            """,
            "items render as a `• line` block separated from body by a blank line"
        )
    }

    /// Nil items returns the raw body unchanged.
    func testRenderBodyFallsBackToBodyWhenItemsAbsent() {
        let event = NotificationEvent(
            body: "Stop hook fired",
            channel: "tts",
            items: nil
        )
        XCTAssertEqual(TTSObserver.renderBody(for: event), "Stop hook fired")
    }

    /// Empty items array degrades cleanly — no orphan blank line.
    func testRenderBodyFallsBackToBodyWhenItemsEmpty() {
        let event = NotificationEvent(body: "Stop hook fired", items: [])
        XCTAssertEqual(TTSObserver.renderBody(for: event), "Stop hook fired")
    }

    /// Whitespace-only entries are filtered so stray `\n` from the agent
    /// bullet generator can't produce orphan `• ` lines.
    func testRenderBodyFiltersWhitespaceOnlyItems() {
        let event = NotificationEvent(
            body: "summary",
            items: ["real item", "   ", ""]
        )
        XCTAssertEqual(
            TTSObserver.renderBody(for: event),
            """
            summary

            • real item
            """
        )
    }

    /// When body is empty (some lifecycle channels emit title-only),
    /// the bullets stand alone — no leading blank line.
    func testRenderBodyHandlesEmptyBodyWithItems() {
        let event = NotificationEvent(body: "", items: ["only bullet"])
        XCTAssertEqual(TTSObserver.renderBody(for: event), "• only bullet")
    }

    // MARK: - 3.3 — activation extractor

    /// A non-empty logPath in userInfo routes to `.openFile(URL)`.
    func testActivationTargetOpensFileWhenLogPathPresent() {
        let userInfo: [AnyHashable: Any] = [
            NotificationUserInfoKeys.logPath: "/tmp/reaper.log"
        ]
        let target = NotificationActivation.target(from: userInfo)
        XCTAssertEqual(target, .openFile(URL(fileURLWithPath: "/tmp/reaper.log")))
    }

    /// Absent logPath returns `.defaultActivation` (the fallback path
    /// that preserves pre-fix behavior for non-reaper notifications).
    func testActivationTargetDefaultsWhenLogPathAbsent() {
        let userInfo: [AnyHashable: Any] = [:]
        XCTAssertEqual(
            NotificationActivation.target(from: userInfo),
            .defaultActivation
        )
    }

    /// Empty / whitespace logPath is treated as "no path".
    func testActivationTargetDefaultsWhenLogPathEmpty() {
        XCTAssertEqual(
            NotificationActivation.target(from: [NotificationUserInfoKeys.logPath: ""]),
            .defaultActivation
        )
        XCTAssertEqual(
            NotificationActivation.target(from: [NotificationUserInfoKeys.logPath: "   "]),
            .defaultActivation
        )
    }

    /// A non-string value (defensive — userInfo dictionaries are
    /// `[AnyHashable: Any]` so the wire shape could in theory leak a
    /// number / array) routes to default activation without crashing.
    func testActivationTargetDefaultsWhenLogPathNonString() {
        let userInfo: [AnyHashable: Any] = [
            NotificationUserInfoKeys.logPath: 42
        ]
        XCTAssertEqual(
            NotificationActivation.target(from: userInfo),
            .defaultActivation
        )
    }
}
