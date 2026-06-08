// SourceStatus — Codable mirror of one row in the mx aggregator's source
// index (the `SourceService` registry fan-out over mx/v1/source.proto).
//
// Spec: mx-bzzb [nx-ui] Shell / source index view (epic mx-rkir)
// Wireframe: docs/nx-ui/nx-wireframe-shell-source-index.html (in the mx repo).
//
// Source of truth (WHEN SHIPPED): the Nexus agent's source-index aggregator
// endpoint (Wave-4, unshipped at time of writing — see fetchSourceIndex()).
// Until that lands the view renders mock data via #Preview + graceful empty /
// error states; the model + fetch are wired to the endpoint it WILL have.
//
// Decoding is unknown-tolerant + permissive (snake_case wire keys, flexible
// dates) per the HealthSnapshot / Session convention: unknown keys are
// ignored, and an unrecognised enum string falls back to a neutral case
// rather than throwing, so server-side extensions don't break the client.

import Foundation

/// Per-source serving health, mirroring `HealthResponse.status`
/// (SERVING / DEGRADED / NOT_SERVING). `unknown` is the neutral fallback for
/// a legacy / unrecognised wire string.
public enum SourceHealth: String, Codable, Sendable, CaseIterable {
    case serving      = "SERVING"
    case degraded     = "DEGRADED"
    case notServing   = "NOT_SERVING"
    case unknown      = "UNKNOWN"

    /// Tolerant decode — an unexpected raw value maps to `.unknown` rather
    /// than throwing (matches the file's "unknown keys are ignored" contract).
    public init(wire raw: String?) {
        guard let raw else { self = .unknown; return }
        self = SourceHealth(rawValue: raw.uppercased()) ?? .unknown
    }

    /// Display token used by the CLI-style status footer ("teams SERVING(42)").
    public var footerToken: String {
        switch self {
        case .serving:    return "SERVING"
        case .degraded:   return "DEGRADED"
        case .notServing: return "DOWN"
        case .unknown:    return "?"
        }
    }
}

/// Who currently owns the item, mirroring `Core.ball_in_court`. Drives the
/// MINE hero count and per-source MINE badge.
public enum BallInCourt: String, Codable, Sendable {
    case mine    = "MINE"
    case theirs  = "THEIRS"
    case unclear = "UNCLEAR"

    public init(wire raw: String?) {
        guard let raw else { self = .unclear; return }
        self = BallInCourt(rawValue: raw.uppercased()) ?? .unclear
    }
}

/// One source in the registry fan-out. Aggregated sources (teams, ado,
/// outlook, gmail, gcal, outlook-calendar, snow, imessage) feed the Triage
/// section; non-aggregated sources (sessions, health, plaid) feed the Sources
/// section — partitioned by `inAggregate`.
public struct SourceStatus: Identifiable, Equatable, Hashable, Decodable, Sendable {
    /// Stable registry slug — "teams", "ado", "gmail", … . Identity key.
    public var id: String
    /// Human display name — "Teams", "Azure DevOps", "Google Calendar".
    public var displayName: String
    /// `CapabilitiesResponse.produces_kind` — "CHAT_MESSAGE", "EMAIL",
    /// "WORK_ITEM", "CALENDAR_EVENT", … . Rendered as the kind tag.
    public var producesKind: String?
    /// `registry.Aggregated()` membership — true = Triage feed, false = own
    /// surface (sessions/health/plaid).
    public var inAggregate: Bool
    /// `HealthResponse.status` (SERVING / DEGRADED / NOT_SERVING).
    public var health: SourceHealth
    /// Human reason when degraded / down — resolved server-side from
    /// `credential_degraded` / `expiring_soon` / `token_expires_at` /
    /// `reason` (e.g. "token expires in 2d", "INTERACTIVE_REQUIRED").
    public var healthReason: String?
    /// `HealthResponse.last_sync_at` — drives "synced Nago" relative time.
    public var lastSyncAt: Date?
    /// `ListResponse.items.length` — total item count. nil when down (renders
    /// as "—").
    public var itemCount: Int?
    /// MINE subset count — `count(items where Core.ball_in_court == MINE)`.
    public var mineCount: Int
    /// `Capabilities.can_search` — gates the search affordance.
    public var canSearch: Bool
    /// `Capabilities.can_stream` — gates the LIVE badge.
    public var canStream: Bool

    public enum CodingKeys: String, CodingKey {
        case id
        case displayName  = "display_name"
        case producesKind = "produces_kind"
        case inAggregate  = "in_aggregate"
        case status                                   // HealthResponse.status
        case healthReason = "reason"
        case lastSyncAt   = "last_sync_at"
        case itemCount    = "item_count"
        case mineCount    = "mine_count"
        case canSearch    = "can_search"
        case canStream    = "can_stream"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id           = try c.decode(String.self, forKey: .id)
        self.displayName  = (try? c.decode(String.self, forKey: .displayName)) ?? id
        self.producesKind = try? c.decode(String.self, forKey: .producesKind)
        self.inAggregate  = (try? c.decode(Bool.self, forKey: .inAggregate)) ?? true
        let statusRaw     = try? c.decode(String.self, forKey: .status)
        self.health       = SourceHealth(wire: statusRaw)
        let reasonRaw     = try? c.decode(String.self, forKey: .healthReason)
        self.healthReason = (reasonRaw?.isEmpty ?? true) ? nil : reasonRaw
        self.lastSyncAt   = SourceStatus.decodePermissiveDate(c, .lastSyncAt)
        self.itemCount    = try? c.decode(Int.self, forKey: .itemCount)
        self.mineCount    = (try? c.decode(Int.self, forKey: .mineCount)) ?? 0
        self.canSearch    = (try? c.decode(Bool.self, forKey: .canSearch)) ?? false
        self.canStream    = (try? c.decode(Bool.self, forKey: .canStream)) ?? false
    }

    public init(
        id: String,
        displayName: String,
        producesKind: String? = nil,
        inAggregate: Bool = true,
        health: SourceHealth = .serving,
        healthReason: String? = nil,
        lastSyncAt: Date? = nil,
        itemCount: Int? = nil,
        mineCount: Int = 0,
        canSearch: Bool = false,
        canStream: Bool = false
    ) {
        self.id = id
        self.displayName = displayName
        self.producesKind = producesKind
        self.inAggregate = inAggregate
        self.health = health
        self.healthReason = healthReason
        self.lastSyncAt = lastSyncAt
        self.itemCount = itemCount
        self.mineCount = mineCount
        self.canSearch = canSearch
        self.canStream = canStream
    }

    /// CLI-style status-footer fragment for this source — "teams SERVING(42)",
    /// "ado DOWN", "gmail DEGRADED(31)". Mirrors the aggregator per-source
    /// Status line the wireframe footer renders.
    public var footerFragment: String {
        switch health {
        case .notServing:
            return "\(id) DOWN"
        case .unknown:
            return "\(id) ?"
        case .serving, .degraded:
            if let n = itemCount {
                return "\(id) \(health.footerToken)(\(n))"
            }
            return "\(id) \(health.footerToken)"
        }
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

/// One item in the cross-source MINE inbox preview (macOS middle pane).
/// Mirrors the `Core` envelope fields the preview row binds (title, author,
/// source slug, kind, ball-in-court, last-activity).
public struct BallInCourtItem: Identifiable, Equatable, Hashable, Decodable, Sendable {
    /// `Core.id` — stable item id.
    public var id: String
    /// `Core.author` — sender / actor display name.
    public var author: String
    /// `Core.title` (or CommsBody.summary) — one-line summary.
    public var title: String
    /// Owning source slug — "teams", "outlook", "gmail", … .
    public var source: String
    /// `CapabilitiesResponse.produces_kind` for the owning source.
    public var producesKind: String?
    /// `Core.ball_in_court` — the preview only lists MINE items, but the
    /// field is carried so the row line-color matches the legend.
    public var ballInCourt: BallInCourt
    /// `Core.last_activity_at` — drives the relative "3m" timestamp.
    public var lastActivityAt: Date?
    /// `Core.url` — read-only deep link ("Open in source").
    public var url: String?

    public enum CodingKeys: String, CodingKey {
        case id
        case author
        case title
        case source
        case producesKind   = "produces_kind"
        case ballInCourt    = "ball_in_court"
        case lastActivityAt = "last_activity_at"
        case url
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id           = try c.decode(String.self, forKey: .id)
        self.author       = (try? c.decode(String.self, forKey: .author)) ?? ""
        self.title        = (try? c.decode(String.self, forKey: .title)) ?? ""
        self.source       = (try? c.decode(String.self, forKey: .source)) ?? ""
        self.producesKind = try? c.decode(String.self, forKey: .producesKind)
        let bicRaw        = try? c.decode(String.self, forKey: .ballInCourt)
        self.ballInCourt  = BallInCourt(wire: bicRaw)
        self.lastActivityAt = BallInCourtItem.decodePermissiveDate(c, .lastActivityAt)
        self.url          = try? c.decode(String.self, forKey: .url)
    }

    public init(
        id: String,
        author: String,
        title: String,
        source: String,
        producesKind: String? = nil,
        ballInCourt: BallInCourt = .mine,
        lastActivityAt: Date? = nil,
        url: String? = nil
    ) {
        self.id = id
        self.author = author
        self.title = title
        self.source = source
        self.producesKind = producesKind
        self.ballInCourt = ballInCourt
        self.lastActivityAt = lastActivityAt
        self.url = url
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

/// The aggregator's full source-index payload — the registry fan-out plus the
/// cross-source MINE inbox preview. Returned by `GET /sources` (WHEN SHIPPED).
public struct SourceIndex: Equatable, Hashable, Decodable, Sendable {
    /// Every source in the registry (both aggregated + non-aggregated).
    public var sources: [SourceStatus]
    /// Cross-source MINE inbox preview rows (macOS middle pane). May be empty
    /// even when the hero count is non-zero (server caps the preview).
    public var inbox: [BallInCourtItem]

    public enum CodingKeys: String, CodingKey {
        case sources
        case inbox
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sources = (try? c.decode([SourceStatus].self, forKey: .sources)) ?? []
        self.inbox   = (try? c.decode([BallInCourtItem].self, forKey: .inbox)) ?? []
    }

    public init(sources: [SourceStatus], inbox: [BallInCourtItem] = []) {
        self.sources = sources
        self.inbox = inbox
    }

    // MARK: - Derived selectors

    /// `registry.Aggregated()` — InAggregate=true, for the Triage section.
    public var aggregatedSources: [SourceStatus] {
        sources.filter(\.inAggregate)
    }

    /// InAggregate=false — own surfaces (sessions/health/plaid).
    public var ownSurfaceSources: [SourceStatus] {
        sources.filter { !$0.inAggregate }
    }

    /// MINE "ball in court" hero count — sum of MINE across aggregated sources
    /// (`count(items where Core.ball_in_court == MINE)` over Aggregated()).
    public var mineHeroCount: Int {
        aggregatedSources.reduce(0) { $0 + $1.mineCount }
    }

    /// Number of aggregated sources contributing to the hero ("across N
    /// aggregated sources").
    public var aggregatedSourceCount: Int {
        aggregatedSources.count
    }

    /// CLI-style aggregate status footer — "teams SERVING(42) | ado DOWN | …"
    /// over the aggregated sources (mirrors the aggregator per-source Status
    /// line). Joins with " | " to match the wireframe footer.
    public var statusFooterLine: String {
        aggregatedSources.map(\.footerFragment).joined(separator: " | ")
    }
}

// MARK: - Sample data

extension SourceIndex {
    /// Representative sample of the Source Index (mirrors the wireframe content):
    /// ~8 aggregated sources with mixed SERVING/DEGRADED/NOT_SERVING + MINE counts,
    /// plus sessions/health/plaid as own-surfaces, and a populated ball-in-court inbox.
    ///
    /// Used by the macOS `#Preview` and by the iOS `SourcesScene` as a stand-in while
    /// the live `/sources` aggregate endpoint is unbuilt (returns empty). Always
    /// rendered with a visible "Sample data" caption so it is never mistaken for live
    /// state.
    public static let sampleData: SourceIndex = {
        let now = Date()
        func ago(_ s: TimeInterval) -> Date { now.addingTimeInterval(-s) }

        let sources: [SourceStatus] = [
            SourceStatus(id: "teams", displayName: "Teams", producesKind: "CHAT_MESSAGE",
                         inAggregate: true, health: .serving, lastSyncAt: ago(180),
                         itemCount: 42, mineCount: 6, canSearch: true, canStream: true),
            SourceStatus(id: "ado", displayName: "Azure DevOps", producesKind: "WORK_ITEM",
                         inAggregate: true, health: .notServing,
                         healthReason: "INTERACTIVE_REQUIRED", itemCount: nil, mineCount: 0,
                         canSearch: true),
            SourceStatus(id: "outlook", displayName: "Outlook", producesKind: "EMAIL",
                         inAggregate: true, health: .serving, lastSyncAt: ago(60),
                         itemCount: 18, mineCount: 3, canSearch: true),
            SourceStatus(id: "gmail", displayName: "Gmail", producesKind: "EMAIL",
                         inAggregate: true, health: .degraded,
                         healthReason: "token expires in 2d", lastSyncAt: ago(120),
                         itemCount: 31, mineCount: 5, canSearch: true),
            SourceStatus(id: "gcal", displayName: "Google Calendar", producesKind: "CALENDAR_EVENT",
                         inAggregate: true, health: .serving, lastSyncAt: ago(300),
                         itemCount: 9, mineCount: 2),
            SourceStatus(id: "outlook-calendar", displayName: "Outlook Calendar",
                         producesKind: "CALENDAR_EVENT", inAggregate: true, health: .serving,
                         lastSyncAt: ago(300), itemCount: 6, mineCount: 1),
            SourceStatus(id: "snow", displayName: "ServiceNow", producesKind: "TICKET",
                         inAggregate: true, health: .degraded,
                         healthReason: "credential degraded", itemCount: 7, mineCount: 0,
                         canSearch: true),
            SourceStatus(id: "imessage", displayName: "iMessage", producesKind: "CHAT_MESSAGE",
                         inAggregate: true, health: .serving, lastSyncAt: ago(12),
                         itemCount: 14, mineCount: 0, canStream: true),
            SourceStatus(id: "sessions", displayName: "Claude Sessions", producesKind: "CODE_SESSION",
                         inAggregate: false, health: .serving, itemCount: 5, canStream: true),
            SourceStatus(id: "health", displayName: "Health", producesKind: "HEALTH_METRIC",
                         inAggregate: false, health: .serving, itemCount: 2),
            SourceStatus(id: "plaid", displayName: "Plaid", producesKind: "FINANCE_TXN",
                         inAggregate: false, health: .degraded,
                         healthReason: "re-auth bank link", itemCount: 23),
        ]
        let inbox: [BallInCourtItem] = [
            BallInCourtItem(id: "1", author: "Priya Nair",
                            title: "Can you sign off the Q3 migration runbook before EOD?",
                            source: "teams", producesKind: "CHAT_MESSAGE", lastActivityAt: ago(180)),
            BallInCourtItem(id: "2", author: "accounts@vendor.io",
                            title: "Re: Renewal quote — awaiting your PO number",
                            source: "outlook", producesKind: "EMAIL", lastActivityAt: ago(1320)),
            BallInCourtItem(id: "3", author: "Dana Whitcomb",
                            title: "Reply needed: school pickup swap on Thursday?",
                            source: "gmail", producesKind: "EMAIL", lastActivityAt: ago(3600)),
            BallInCourtItem(id: "4", author: "Design review",
                            title: "RSVP needsAction — tomorrow 10:00",
                            source: "gcal", producesKind: "CALENDAR_EVENT", lastActivityAt: ago(7200)),
        ]
        return SourceIndex(sources: sources, inbox: inbox)
    }()
}
