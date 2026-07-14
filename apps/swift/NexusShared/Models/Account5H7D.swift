// Account5H7D — Codable mirror of the composed `GET /statusline?accountId=<id>`
// account-mode response.
//
// Spec: openspec/changes/redesign-status-usage-endpoints (task 3.1) — bd:nx-rqpio
//
// Source of truth: apps/agent/src/routes/statusline.ts (accountId-mode) which
// reads `credentials.usage5hUsed/Limit/ResetAt` + `usage7dUsed/Limit/ResetAt`
// by id and returns `{ account: Account5H7D }` (404 if the id is unknown).
//
// This is the authoritative account-usage read model now that
// `Account.usagePercent` / `Account.resetsAt` are removed from `GET /credentials`
// (the credentials endpoint is a pure account registry). The Swift dashboard's
// Credentials view sources its per-row 5h / 7d bars from here, falling back to
// the (older) `CcProfile` usage fields when the composed endpoint 404s.

import Foundation

/// One resource window (5h or 7d) of an account's usage. `resetsAt` arrives as
/// an ISO-8601 string or `null`; decoded permissively to a `Date?`.
public struct AccountUsageWindow: Decodable, Equatable, Hashable, Sendable {
    public var used: Int
    public var limit: Int
    public var resetsAt: Date?

    public init(used: Int, limit: Int, resetsAt: Date? = nil) {
        self.used = used
        self.limit = limit
        self.resetsAt = resetsAt
    }

    public enum CodingKeys: String, CodingKey {
        case used
        case limit
        case resetsAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.used = (try? c.decode(Int.self, forKey: .used)) ?? 0
        self.limit = (try? c.decode(Int.self, forKey: .limit)) ?? 0
        self.resetsAt = AccountUsageWindow.decodePermissiveDate(c, .resetsAt)
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

/// The account-mode `GET /statusline?accountId=<id>` payload: 5h + 7d usage
/// windows keyed by account (credential) id. Unknown keys are ignored by the
/// decoder; a missing `fiveHour` / `sevenDay` degrades to a zero window rather
/// than throwing so an older/partial agent response still renders.
public struct Account5H7D: Decodable, Equatable, Hashable, Sendable {
    public var accountId: String
    public var fiveHour: AccountUsageWindow
    public var sevenDay: AccountUsageWindow

    public init(
        accountId: String,
        fiveHour: AccountUsageWindow,
        sevenDay: AccountUsageWindow
    ) {
        self.accountId = accountId
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
    }

    public enum CodingKeys: String, CodingKey {
        case accountId
        case fiveHour
        case sevenDay
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.accountId = (try? c.decode(String.self, forKey: .accountId)) ?? ""
        self.fiveHour = (try? c.decode(AccountUsageWindow.self, forKey: .fiveHour))
            ?? AccountUsageWindow(used: 0, limit: 0)
        self.sevenDay = (try? c.decode(AccountUsageWindow.self, forKey: .sevenDay))
            ?? AccountUsageWindow(used: 0, limit: 0)
    }
}

/// Envelope for the account-mode `GET /statusline?accountId=<id>` response —
/// `{ "account": Account5H7D }`.
public struct AccountStatusEnvelope: Decodable, Sendable {
    public var account: Account5H7D

    public init(account: Account5H7D) {
        self.account = account
    }
}
