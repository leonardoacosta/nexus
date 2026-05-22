// SpecSession — Codable mirror of one row from
// `GET /specs/{project}/{name}/sessions`.
//
// Spec: openspec/changes/specs-tab-start-on-spec § Endpoint Wiring.
//
// The agent emits rows already projected from the spec_sessions ⨝ sessions
// join, so this struct is intentionally flat: nothing here re-derives
// `active` — that's the server's job.
//
// Cross-platform: no AppKit / UIKit imports so iOS + watchOS targets can
// reuse the same decoder.

import Foundation

public struct SpecSession: Identifiable, Equatable, Hashable, Codable, Sendable {
    /// Identity row id from `spec_sessions.id`. Stable across the link's
    /// lifetime; `active` may flip from true→false when the underlying
    /// session ends.
    public var id: Int
    /// The Nexus session id (e.g. `nx-1718394012`). Matches `sessions.id`.
    public var sessionId: String
    /// Server-stamped row insert time (ISO-8601 with TZ offset).
    public var createdAt: Date
    /// True iff the linked session row still exists in the registry AND
    /// `ended_at IS NULL`. False for historical rows (session vanished or
    /// ended).
    public var active: Bool

    public enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case createdAt = "created_at"
        case active
    }

    public init(id: Int, sessionId: String, createdAt: Date, active: Bool) {
        self.id = id
        self.sessionId = sessionId
        self.createdAt = createdAt
        self.active = active
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(Int.self, forKey: .id)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
        self.active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
        // ISO-8601 with optional fractional seconds — match SpecSummary's
        // tolerant decoder.
        let s = try c.decode(String.self, forKey: .createdAt)
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        if let d = f1.date(from: s) ?? f2.date(from: s) {
            self.createdAt = d
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: .createdAt,
                in: c,
                debugDescription: "unparseable createdAt: \(s)"
            )
        }
    }
}

/// Envelope returned by `GET /specs/{project}/{name}/sessions`:
/// `{ "sessions": [...] }`.
public struct SpecSessionsResponse: Decodable, Sendable {
    public var sessions: [SpecSession]
    public init(sessions: [SpecSession]) {
        self.sessions = sessions
    }
}
