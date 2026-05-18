// IntegrationStatus — Codable mirror of the agent's integration registry.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.10)
// bd:nx-gaquu
//
// Mirrors the web `/integrations` route, which today only ships an
// `/integrations/elevenlabs` sub-route. The agent does not yet expose a
// `GET /integrations` aggregate; the dashboard fans-out per integration
// when needed. This model is the unified envelope the Swift surface
// renders so adding new integrations is one row in the agent's response.

import Foundation

public struct IntegrationStatus: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: String
    public var name: String
    /// "connected", "disconnected", "error", "not-configured".
    public var status: String
    /// Optional badge text — e.g. "v1.2.3", "Pro plan", "rate-limited".
    public var detail: String?
    /// When the integration was last contacted successfully. nil ⇒ never.
    public var lastSeenAt: Date?
    /// Optional dashboard URL the user can click through to manage it.
    public var manageUrl: String?

    public enum CodingKeys: String, CodingKey {
        case id
        case name
        case status
        case detail
        case lastSeenAt
        case manageUrl
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = (try? c.decode(String.self, forKey: .name)) ?? id
        self.status = (try? c.decode(String.self, forKey: .status)) ?? "unknown"
        self.detail = try? c.decode(String.self, forKey: .detail)
        self.lastSeenAt = IntegrationStatus.decodePermissiveDate(c, .lastSeenAt)
        self.manageUrl = try? c.decode(String.self, forKey: .manageUrl)
    }

    public init(
        id: String,
        name: String,
        status: String,
        detail: String? = nil,
        lastSeenAt: Date? = nil,
        manageUrl: String? = nil
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.detail = detail
        self.lastSeenAt = lastSeenAt
        self.manageUrl = manageUrl
    }

    private static func decodePermissiveDate(
        _ c: KeyedDecodingContainer<CodingKeys>,
        _ key: CodingKeys
    ) -> Date? {
        if let s = try? c.decode(String.self, forKey: key) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            return f1.date(from: s) ?? f2.date(from: s)
        }
        if let n = try? c.decode(Double.self, forKey: key) {
            return n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
                : Date(timeIntervalSince1970: n)
        }
        return nil
    }
}
