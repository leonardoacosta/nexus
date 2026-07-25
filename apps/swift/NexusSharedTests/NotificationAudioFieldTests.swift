// NotificationAudioFieldTests — pin the optional `audioAvailable` and
// `voiceUsed` decode/encode round trip added by openspec/changes/
// notifications-overhaul (UI batch task 3.1).
//
// Two scenarios:
//   1. Old payload (neither field present) — decodes cleanly with
//      nil values. Round-trip via encoder MUST NOT emit the keys.
//   2. New payload (both present) — decodes to the expected values
//      and round-trips back on the same key spellings.

import XCTest
@testable import NexusShared

final class NotificationAudioFieldTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(type, from: data)
    }

    private func encodeAsDictionary(_ event: NotificationEvent) throws -> [String: Any] {
        let data = try JSONEncoder().encode(event)
        let any = try JSONSerialization.jsonObject(with: data)
        return (any as? [String: Any]) ?? [:]
    }

    /// Old payload — pre-overhaul agent omits both keys. Decoder MUST
    /// produce nil for both fields and the optional ladder upstream
    /// stays back-compat with prior wave consumers.
    func testOldPayloadDecodesWithNilAudioFields() throws {
        let json = """
        {
            "id": "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
            "title": "Old payload",
            "body": "Pre-overhaul agent",
            "channel": "tts",
            "project": "nx",
            "severity": "info",
            "delivery_state": "delivered",
            "created_at": "2026-05-21T03:00:00.000Z"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertNil(n.audioAvailable, "audioAvailable absent -> nil")
        XCTAssertNil(n.voiceUsed, "voiceUsed absent -> nil")

        // Round-trip: nil optionals MUST NOT appear in the encoded JSON
        // (encodeIfPresent semantics).
        let encoded = try encodeAsDictionary(n)
        XCTAssertNil(encoded["audioAvailable"], "nil audioAvailable not emitted")
        XCTAssertNil(encoded["voiceUsed"], "nil voiceUsed not emitted")
    }

    /// New payload — both fields populated. Decode + round-trip both
    /// preserve the values verbatim.
    func testNewPayloadDecodesAudioFields() throws {
        let json = """
        {
            "id": "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
            "title": "Synth landed",
            "body": "Voice cached on agent",
            "channel": "tts",
            "project": "nx",
            "severity": "info",
            "delivery_state": "delivered",
            "created_at": "2026-05-21T03:00:00.000Z",
            "audioAvailable": true,
            "voiceUsed": "21m00Tcm4TlvDq8ikWAM"
        }
        """
        let n = try decode(NotificationEvent.self, from: json)
        XCTAssertEqual(n.audioAvailable, true, "audioAvailable decodes the boolean")
        XCTAssertEqual(
            n.voiceUsed,
            "21m00Tcm4TlvDq8ikWAM",
            "voiceUsed decodes the ElevenLabs voice id verbatim"
        )

        let encoded = try encodeAsDictionary(n)
        XCTAssertEqual(encoded["audioAvailable"] as? Bool, true)
        XCTAssertEqual(encoded["voiceUsed"] as? String, "21m00Tcm4TlvDq8ikWAM")
    }
}
// green-verification touch 1784955809
