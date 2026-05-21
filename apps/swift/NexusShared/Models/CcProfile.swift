// CcProfile — Codable mirror of the agent's `cc_profiles` row.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.5)
// bd:nx-gaquu
//
// Source of truth: apps/agent/src/cc-credential-manager.ts (`CcProfileSnapshot`)
// and the `GET /credentials` envelope which exposes one entry per CC profile.
//
// Read-only — the agent owns swap and refresh decisions. The Swift dashboard
// renders this for at-a-glance triage: which account is active, which are
// rate-limited, which have an expired OAuth token.

import Foundation

/// One row from `GET /credentials` (the public list endpoint) reframed for
/// the dashboard's CC-profile lens. We carry only the fields the dashboard
/// shows; unknown keys are ignored by the JSON decoder.
public struct CcProfile: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: String
    public var name: String
    public var fingerprint: String
    public var subscriptionType: String?
    public var rateLimitTier: String?
    public var accountEmail: String?
    public var accountName: String?
    public var orgName: String?
    public var status: String
    public var expiresAt: Date?
    /// Number of times this profile has received a 429 in the trailing window.
    public var rateLimit429Count: Int
    /// When the agent last swapped to or from this profile.
    public var lastSwapAt: Date?
    /// True when this fingerprint matches the agent's `activeFingerprint`.
    public var isActive: Bool

    // MARK: - Usage snapshot (credentials-account-resolve-and-usage)
    //
    // Populated by the agent's `credential-usage-poller` service every
    // 5 minutes; nil until the first successful poll. The 5-hour and
    // 7-day windows mirror Anthropic's /api/oauth/usage shape.
    public var usage5hUsed: Int?
    public var usage5hLimit: Int?
    public var usage5hResetAt: Date?
    public var usage7dUsed: Int?
    public var usage7dLimit: Int?
    public var usage7dResetAt: Date?
    public var usagePolledAt: Date?

    // MARK: - Dedupe metadata (credentials-account-resolve-and-usage)
    //
    // Present only when the dashboard requested `GET /credentials?dedupe=true`.
    // `siblingCount == 0` means this row's group has no hidden duplicates.
    public var siblingCount: Int?
    public var siblingIds: [String]?

    public enum CodingKeys: String, CodingKey {
        case id
        case name
        case fingerprint
        case subscriptionType
        case rateLimitTier
        case accountEmail
        case accountName
        case orgName
        case status
        case expiresAt
        case rateLimit429Count = "rateLimit429Count"
        case lastSwapAt = "lastSwapAt"
        case isActive = "isActive"
        case usage5hUsed
        case usage5hLimit
        case usage5hResetAt
        case usage7dUsed
        case usage7dLimit
        case usage7dResetAt
        case usagePolledAt
        case siblingCount
        case siblingIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = (try? c.decode(String.self, forKey: .name)) ?? ""
        self.fingerprint = (try? c.decode(String.self, forKey: .fingerprint)) ?? ""
        self.subscriptionType = try? c.decode(String.self, forKey: .subscriptionType)
        self.rateLimitTier = try? c.decode(String.self, forKey: .rateLimitTier)
        self.accountEmail = try? c.decode(String.self, forKey: .accountEmail)
        self.accountName = try? c.decode(String.self, forKey: .accountName)
        self.orgName = try? c.decode(String.self, forKey: .orgName)
        self.status = (try? c.decode(String.self, forKey: .status)) ?? "unknown"
        self.expiresAt = CcProfile.decodePermissiveDate(c, .expiresAt)
        self.rateLimit429Count = (try? c.decode(Int.self, forKey: .rateLimit429Count)) ?? 0
        self.lastSwapAt = CcProfile.decodePermissiveDate(c, .lastSwapAt)
        self.isActive = (try? c.decode(Bool.self, forKey: .isActive)) ?? false
        self.usage5hUsed = try? c.decode(Int.self, forKey: .usage5hUsed)
        self.usage5hLimit = try? c.decode(Int.self, forKey: .usage5hLimit)
        self.usage5hResetAt = CcProfile.decodePermissiveDate(c, .usage5hResetAt)
        self.usage7dUsed = try? c.decode(Int.self, forKey: .usage7dUsed)
        self.usage7dLimit = try? c.decode(Int.self, forKey: .usage7dLimit)
        self.usage7dResetAt = CcProfile.decodePermissiveDate(c, .usage7dResetAt)
        self.usagePolledAt = CcProfile.decodePermissiveDate(c, .usagePolledAt)
        self.siblingCount = try? c.decode(Int.self, forKey: .siblingCount)
        self.siblingIds = try? c.decode([String].self, forKey: .siblingIds)
    }

    public init(
        id: String,
        name: String,
        fingerprint: String,
        subscriptionType: String? = nil,
        rateLimitTier: String? = nil,
        accountEmail: String? = nil,
        accountName: String? = nil,
        orgName: String? = nil,
        status: String = "unknown",
        expiresAt: Date? = nil,
        rateLimit429Count: Int = 0,
        lastSwapAt: Date? = nil,
        isActive: Bool = false,
        usage5hUsed: Int? = nil,
        usage5hLimit: Int? = nil,
        usage5hResetAt: Date? = nil,
        usage7dUsed: Int? = nil,
        usage7dLimit: Int? = nil,
        usage7dResetAt: Date? = nil,
        usagePolledAt: Date? = nil,
        siblingCount: Int? = nil,
        siblingIds: [String]? = nil
    ) {
        self.id = id
        self.name = name
        self.fingerprint = fingerprint
        self.subscriptionType = subscriptionType
        self.rateLimitTier = rateLimitTier
        self.accountEmail = accountEmail
        self.accountName = accountName
        self.orgName = orgName
        self.status = status
        self.expiresAt = expiresAt
        self.rateLimit429Count = rateLimit429Count
        self.lastSwapAt = lastSwapAt
        self.isActive = isActive
        self.usage5hUsed = usage5hUsed
        self.usage5hLimit = usage5hLimit
        self.usage5hResetAt = usage5hResetAt
        self.usage7dUsed = usage7dUsed
        self.usage7dLimit = usage7dLimit
        self.usage7dResetAt = usage7dResetAt
        self.usagePolledAt = usagePolledAt
        self.siblingCount = siblingCount
        self.siblingIds = siblingIds
    }

    /// Return a copy with `isActive = true` — used by `NexusClient.fetchCredentials()`
    /// to stamp the row whose fingerprint matches the envelope's
    /// `activeFingerprint` so the UI never needs to thread that field through.
    public func markActive() -> CcProfile {
        var copy = self
        copy.isActive = true
        return copy
    }

    /// Human-readable OAuth state: "valid", "expired", "refreshing", or "unknown".
    public var oauthState: String {
        if let expiresAt {
            if expiresAt < Date() { return "expired" }
            if expiresAt.timeIntervalSinceNow < 300 { return "refreshing" }
            return "valid"
        }
        return status.lowercased() == "active" ? "valid" : "unknown"
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

/// Envelope for `GET /credentials` — wraps the profile list plus the
/// currently-active fingerprint so the dashboard can flag the live row.
public struct CredentialListResponse: Decodable, Sendable {
    public var credentials: [CcProfile]
    public var activeFingerprint: String?
}
