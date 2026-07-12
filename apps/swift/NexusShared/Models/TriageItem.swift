// TriageItem — the unified cross-source item: a shared `Core` spine + a
// `TriagePayload` oneof of five family bodies. Codable mirror of mx/v1/source.proto
// (`message TriageItem { Core core = 1; TriagePayload payload = 2; }`), the wire
// contract every archetype iOS page consumes.
//
// Spec: mx-rkir [nx-ui] — six archetype pages (comms / calendar / finance /
// health / sessions / detail) all render this one model.
// Proto: ~/dev/mx/proto/mx/v1/source.proto (Core + TriagePayload oneof).
//
// SOURCE OF TRUTH (WHEN SHIPPED): the Nexus agent's triage aggregator endpoint
// (`GET /triage`, unshipped at time of writing — see NexusClient.fetchTriage()).
// Until it lands the views render `TriageItem.sampleData` via a TriageObserver
// that swaps in sample state on empty/error (with an `isSampleData` caption so
// it is never mistaken for live state).
//
// WIRE SHAPE: protojson (the canonical connect/gRPC-gateway JSON) emits the
// nested `{ "core": {…}, "payload": { "<arm>": {…} } }` shape with lowerCamelCase
// keys, and accepts snake_case on decode. We are tolerant of BOTH: every field
// reads camelCase OR snake_case, and a Node aggregator that flattens the spine
// (Core fields hoisted to the top level) decodes identically. Decoding is
// unknown-tolerant — an unrecognised `kind`/enum string falls back to a neutral
// case, an absent/unknown payload arm folds to `.unknown`, so decode NEVER
// throws and server-side extensions don't break the client. Dates are permissive
// (ISO8601 fractional / no-fraction / numeric epoch s|ms), cloning the
// Session.swift / SourceStatus.swift convention.
//
// `BallInCourt` is reused from SourceStatus.swift (cases mine/theirs/unclear,
// wire MINE/THEIRS/UNCLEAR) — do NOT redeclare it here.

import Foundation

// MARK: - Identity

/// Typed identity reference — mirrors proto `IdentityRef`. "We only have a
/// display name" is a first-class valid state (the only populated IdentityKind
/// today is DISPLAY_NAME), so `displayName` is always present and `handle`
/// (the email / UPN / login / e164 raw value) is optional.
public struct IdentityRef: Identifiable, Equatable, Hashable, Codable, Sendable {
    /// Human display form (proto `display`, falling back to the normalized
    /// `value`). Never empty — an item always has *some* author label.
    public var displayName: String
    /// Raw handle — email / UPN / github login / e164 / account id. nil when
    /// the source only observed a display name (the common case today).
    public var handle: String?

    /// Identity is the handle when present (stable), else the display name.
    public var id: String { handle ?? displayName }

    public enum CodingKeys: String, CodingKey {
        case display                     // protojson `display` — original form
        case displayName                 // camelCase alias (some producers)
        case value                       // normalized name (DISPLAY_NAME fallback)
        case handle
        case kind                        // IdentityKind — informs handle vs name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let display = (try? c.decode(String.self, forKey: .display))
            ?? (try? c.decode(String.self, forKey: .displayName))
        let value = try? c.decode(String.self, forKey: .value)
        self.displayName = display ?? value ?? ""
        // `handle` is explicit when present; otherwise derive from `value` for
        // non-DISPLAY_NAME identity kinds (email / UPN / login carry the raw
        // identifier in `value`).
        if let h = try? c.decode(String.self, forKey: .handle), !h.isEmpty {
            self.handle = h
        } else if let v = value, v != display, v.contains(where: { $0 == "@" || $0 == "/" }) {
            self.handle = v
        } else {
            self.handle = nil
        }
    }

    public init(displayName: String, handle: String? = nil) {
        self.displayName = displayName
        self.handle = handle
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(displayName, forKey: .display)
        try c.encodeIfPresent(handle, forKey: .handle)
    }
}

// MARK: - Spine enums

/// `Core.kind` (proto enum `Kind`). The payload arm is keyed off this when the
/// wire omits an explicit oneof discriminator. Unknown-tolerant: an unrecognised
/// wire string decodes to `.unknown`.
public enum TriageKind: String, Codable, Sendable, CaseIterable {
    case email            = "EMAIL"
    case chatMessage      = "CHAT_MESSAGE"
    case ticket           = "TICKET"
    case workItem         = "WORK_ITEM"
    case codeReview       = "CODE_REVIEW"
    case calendarEvent    = "CALENDAR_EVENT"
    case financeTxn       = "FINANCE_TXN"
    case healthMetric     = "HEALTH_METRIC"
    case codeSession      = "CODE_SESSION"
    case note             = "NOTE"
    case media            = "MEDIA"
    case observability    = "OBSERVABILITY"
    case medication       = "MEDICATION"
    case unknown          = "UNKNOWN"

    /// Tolerant decode — maps both the SCREAMING_SNAKE proto form and a
    /// lowerCamel JS form, falling back to `.unknown`.
    public init(wire raw: String?) {
        guard let raw, !raw.isEmpty else { self = .unknown; return }
        if let direct = TriageKind(rawValue: raw.uppercased()) { self = direct; return }
        // Accept camelCase aliases ("chatMessage", "workItem", …).
        switch raw {
        case "chatMessage":   self = .chatMessage
        case "workItem":      self = .workItem
        case "codeReview":    self = .codeReview
        case "calendarEvent": self = .calendarEvent
        case "financeTxn":    self = .financeTxn
        case "healthMetric":  self = .healthMetric
        case "codeSession":   self = .codeSession
        case "medication":    self = .medication
        default:              self = .unknown
        }
    }

    public init(from decoder: Decoder) throws {
        self = TriageKind(wire: try? decoder.singleValueContainer().decode(String.self))
    }
}

// MARK: - Family-body enums (comms)

/// `CommsBody.priority` (proto enum `Priority`). Unknown-tolerant → `.normal`.
public enum CommsPriority: String, Codable, Sendable, CaseIterable {
    case low     = "PRIORITY_LOW"
    case normal  = "PRIORITY_NORMAL"
    case high    = "PRIORITY_HIGH"
    case urgent  = "PRIORITY_URGENT"

    public init(wire raw: String?) {
        guard let raw, !raw.isEmpty else { self = .normal; return }
        switch raw.uppercased() {
        case "PRIORITY_LOW", "LOW":       self = .low
        case "PRIORITY_HIGH", "HIGH":     self = .high
        case "PRIORITY_URGENT", "URGENT": self = .urgent
        default:                          self = .normal
        }
    }

    /// Short display token for the badge ("URGENT", "HIGH", …).
    public var label: String {
        switch self {
        case .low:    return "LOW"
        case .normal: return "NORMAL"
        case .high:   return "HIGH"
        case .urgent: return "URGENT"
        }
    }
}

/// `CommsBody.suggested_disposition` (proto enum `Disposition`). The source-side
/// SUGGESTION (the confirmed/overridden disposition lives aggregator-side).
/// Unknown-tolerant → `.inbox`.
public enum CommsDisposition: String, Codable, Sendable, CaseIterable {
    case inbox    = "INBOX"
    case open     = "OPEN"
    case waiting  = "WAITING"
    case resolved = "RESOLVED"

    public init(wire raw: String?) {
        guard let raw, !raw.isEmpty else { self = .inbox; return }
        switch raw.uppercased() {
        case "OPEN":     self = .open
        case "WAITING":  self = .waiting
        case "RESOLVED": self = .resolved
        default:         self = .inbox
        }
    }

    public var label: String { rawValue }
}

// MARK: - Permissive decode helpers

/// Shared permissive-date + camel/snake-key helpers, factored out so every
/// body decoder uses the identical tolerant rules (clone of the inline
/// decoders in Session.swift / SourceStatus.swift).
enum WireDecode {
    /// Decode a date from any of: ISO8601 fractional, ISO8601 no-fraction, or
    /// numeric epoch (seconds OR milliseconds). Returns nil when absent/unparseable.
    static func date<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ keys: K...) -> Date? {
        for key in keys {
            if let s = try? c.decode(String.self, forKey: key), !s.isEmpty {
                if let d = iso8601Fractional.date(from: s) ?? iso8601Plain.date(from: s) {
                    return d
                }
            }
            if let n = try? c.decode(Double.self, forKey: key) {
                return n > 1_000_000_000_000
                    ? Date(timeIntervalSince1970: n / 1000)
                    : Date(timeIntervalSince1970: n)
            }
        }
        return nil
    }

    /// First non-nil String across the given keys (camel + snake aliases).
    static func string<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ keys: K...) -> String? {
        for key in keys {
            if let s = try? c.decode(String.self, forKey: key) { return s }
        }
        return nil
    }

    /// First non-nil non-empty String across the given keys.
    static func nonEmpty<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ keys: K...) -> String? {
        for key in keys {
            if let s = try? c.decode(String.self, forKey: key), !s.isEmpty { return s }
        }
        return nil
    }

    static func bool<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ keys: K..., default def: Bool = false) -> Bool {
        for key in keys {
            if let b = try? c.decode(Bool.self, forKey: key) { return b }
        }
        return def
    }

    static func double<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ keys: K...) -> Double? {
        for key in keys {
            if let d = try? c.decode(Double.self, forKey: key) { return d }
        }
        return nil
    }

    static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

// MARK: - Family bodies

/// `CommsBody` — family #1 (email / chat / ticket / work_item / code_review).
public struct CommsBody: Equatable, Hashable, Sendable, Decodable {
    public var summary: String?
    public var body: String?
    public var priority: CommsPriority
    /// Real upstream lifecycle for ado/snow ONLY (e.g. "In Review", "Active").
    public var upstreamState: String?
    public var suggestedDisposition: CommsDisposition
    /// Why this disposition (radar "evidence").
    public var dispositionEvidence: String?

    enum CodingKeys: String, CodingKey {
        case summary
        case body
        case priority
        case upstreamState, upstream_state
        case suggestedDisposition, suggested_disposition
        case dispositionEvidence, disposition_evidence
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.summary = WireDecode.nonEmpty(c, .summary)
        self.body = WireDecode.nonEmpty(c, .body)
        self.priority = CommsPriority(wire: WireDecode.string(c, .priority))
        self.upstreamState = WireDecode.nonEmpty(c, .upstreamState, .upstream_state)
        self.suggestedDisposition = CommsDisposition(
            wire: WireDecode.string(c, .suggestedDisposition, .suggested_disposition)
        )
        self.dispositionEvidence = WireDecode.nonEmpty(c, .dispositionEvidence, .disposition_evidence)
    }

    public init(
        summary: String? = nil,
        body: String? = nil,
        priority: CommsPriority = .normal,
        upstreamState: String? = nil,
        suggestedDisposition: CommsDisposition = .inbox,
        dispositionEvidence: String? = nil
    ) {
        self.summary = summary
        self.body = body
        self.priority = priority
        self.upstreamState = upstreamState
        self.suggestedDisposition = suggestedDisposition
        self.dispositionEvidence = dispositionEvidence
    }
}

/// `CalendarAttendee` — per-attendee RSVP tuple for `CalendarBody.attendees`.
public struct CalendarAttendee: Identifiable, Equatable, Hashable, Sendable, Decodable {
    public var email: String
    public var displayName: String?
    /// needsAction / accepted / declined / tentative.
    public var responseStatus: String?
    /// This entry is the authenticated viewer.
    public var isSelf: Bool
    /// This attendee is also the organizer.
    public var organizer: Bool
    /// Not required to attend.
    public var optional: Bool

    public var id: String { email }

    enum CodingKeys: String, CodingKey {
        case email
        case displayName, display
        case responseStatus, response_status
        case isSelf = "self"
        case organizer
        case optional
        case optionalAttendee = "optional_attendee"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.email = WireDecode.string(c, .email) ?? ""
        self.displayName = WireDecode.nonEmpty(c, .displayName, .display)
        self.responseStatus = WireDecode.nonEmpty(c, .responseStatus, .response_status)
        self.isSelf = WireDecode.bool(c, .isSelf)
        self.organizer = WireDecode.bool(c, .organizer)
        self.optional = WireDecode.bool(c, .optional, .optionalAttendee)
    }

    public init(
        email: String,
        displayName: String? = nil,
        responseStatus: String? = nil,
        isSelf: Bool = false,
        organizer: Bool = false,
        optional: Bool = false
    ) {
        self.email = email
        self.displayName = displayName
        self.responseStatus = responseStatus
        self.isSelf = isSelf
        self.organizer = organizer
        self.optional = optional
    }
}

/// `CalendarBody` — family #5 (gcal / outlook-calendar merged).
public struct CalendarBody: Equatable, Hashable, Sendable, Decodable {
    public var startTime: Date?      // absent on all-day
    public var endTime: Date?        // absent on all-day
    public var startDate: String?    // ISO yyyy-MM-dd, all-day only
    public var endDate: String?
    public var allDay: Bool
    public var location: String?
    public var description: String?
    public var isOrganizer: Bool
    /// needsAction / accepted / declined / tentative; nil when not an invitee.
    public var selfResponseStatus: String?
    public var attendees: [CalendarAttendee]
    public var recurringEventId: String?
    public var recurrenceRules: [String]
    /// confirmed / tentative / cancelled (default "confirmed").
    public var eventStatus: String?
    public var conferenceUrl: String?
    public var calendarId: String?
    public var visibility: String?

    enum CodingKeys: String, CodingKey {
        case startTime, start_time
        case endTime, end_time
        case startDate, start_date
        case endDate, end_date
        case allDay, all_day
        case location
        case description
        case isOrganizer, is_organizer
        case selfResponseStatus, self_response_status
        case attendees
        case recurringEventId, recurring_event_id
        case recurrenceRules, recurrence_rules
        case eventStatus, event_status
        case conferenceUrl, conference_url
        case calendarId, calendar_id
        case visibility
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.startTime = WireDecode.date(c, .startTime, .start_time)
        self.endTime = WireDecode.date(c, .endTime, .end_time)
        self.startDate = WireDecode.nonEmpty(c, .startDate, .start_date)
        self.endDate = WireDecode.nonEmpty(c, .endDate, .end_date)
        self.allDay = WireDecode.bool(c, .allDay, .all_day)
        self.location = WireDecode.nonEmpty(c, .location)
        self.description = WireDecode.nonEmpty(c, .description)
        self.isOrganizer = WireDecode.bool(c, .isOrganizer, .is_organizer)
        self.selfResponseStatus = WireDecode.nonEmpty(c, .selfResponseStatus, .self_response_status)
        self.attendees = (try? c.decode([CalendarAttendee].self, forKey: .attendees)) ?? []
        self.recurringEventId = WireDecode.nonEmpty(c, .recurringEventId, .recurring_event_id)
        self.recurrenceRules = (try? c.decode([String].self, forKey: .recurrenceRules))
            ?? (try? c.decode([String].self, forKey: .recurrence_rules)) ?? []
        self.eventStatus = WireDecode.nonEmpty(c, .eventStatus, .event_status)
        self.conferenceUrl = WireDecode.nonEmpty(c, .conferenceUrl, .conference_url)
        self.calendarId = WireDecode.nonEmpty(c, .calendarId, .calendar_id)
        self.visibility = WireDecode.nonEmpty(c, .visibility)
    }

    public init(
        startTime: Date? = nil,
        endTime: Date? = nil,
        startDate: String? = nil,
        endDate: String? = nil,
        allDay: Bool = false,
        location: String? = nil,
        description: String? = nil,
        isOrganizer: Bool = false,
        selfResponseStatus: String? = nil,
        attendees: [CalendarAttendee] = [],
        recurringEventId: String? = nil,
        recurrenceRules: [String] = [],
        eventStatus: String? = nil,
        conferenceUrl: String? = nil,
        calendarId: String? = nil,
        visibility: String? = nil
    ) {
        self.startTime = startTime
        self.endTime = endTime
        self.startDate = startDate
        self.endDate = endDate
        self.allDay = allDay
        self.location = location
        self.description = description
        self.isOrganizer = isOrganizer
        self.selfResponseStatus = selfResponseStatus
        self.attendees = attendees
        self.recurringEventId = recurringEventId
        self.recurrenceRules = recurrenceRules
        self.eventStatus = eventStatus
        self.conferenceUrl = conferenceUrl
        self.calendarId = calendarId
        self.visibility = visibility
    }
}

/// `FinanceBody` — family #3 (plaid). `amount` is signed; positive = outflow.
public struct FinanceBody: Equatable, Hashable, Sendable, Decodable {
    public var amount: Double
    public var isoCurrencyCode: String
    public var merchantName: String?
    public var pending: Bool
    public var paymentChannel: String?    // online | in store | other
    public var categoryPrimary: String?
    public var categoryDetailed: String?
    public var accountName: String?
    public var accountMask: String?
    public var institution: String?
    public var accountType: String?       // depository | credit | ...
    public var balanceCurrent: Double?
    public var balanceAvailable: Double?

    enum CodingKeys: String, CodingKey {
        case amount
        case isoCurrencyCode, iso_currency_code
        case merchantName, merchant_name
        case pending
        case paymentChannel, payment_channel
        case categoryPrimary, category_primary
        case categoryDetailed, category_detailed
        case accountName, account_name
        case accountMask, account_mask
        case institution
        case accountType, account_type
        case balanceCurrent, balance_current
        case balanceAvailable, balance_available
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.amount = WireDecode.double(c, .amount) ?? 0
        self.isoCurrencyCode = WireDecode.string(c, .isoCurrencyCode, .iso_currency_code) ?? "USD"
        self.merchantName = WireDecode.nonEmpty(c, .merchantName, .merchant_name)
        self.pending = WireDecode.bool(c, .pending)
        self.paymentChannel = WireDecode.nonEmpty(c, .paymentChannel, .payment_channel)
        self.categoryPrimary = WireDecode.nonEmpty(c, .categoryPrimary, .category_primary)
        self.categoryDetailed = WireDecode.nonEmpty(c, .categoryDetailed, .category_detailed)
        self.accountName = WireDecode.nonEmpty(c, .accountName, .account_name)
        self.accountMask = WireDecode.nonEmpty(c, .accountMask, .account_mask)
        self.institution = WireDecode.nonEmpty(c, .institution)
        self.accountType = WireDecode.nonEmpty(c, .accountType, .account_type)
        self.balanceCurrent = WireDecode.double(c, .balanceCurrent, .balance_current)
        self.balanceAvailable = WireDecode.double(c, .balanceAvailable, .balance_available)
    }

    public init(
        amount: Double,
        isoCurrencyCode: String = "USD",
        merchantName: String? = nil,
        pending: Bool = false,
        paymentChannel: String? = nil,
        categoryPrimary: String? = nil,
        categoryDetailed: String? = nil,
        accountName: String? = nil,
        accountMask: String? = nil,
        institution: String? = nil,
        accountType: String? = nil,
        balanceCurrent: Double? = nil,
        balanceAvailable: Double? = nil
    ) {
        self.amount = amount
        self.isoCurrencyCode = isoCurrencyCode
        self.merchantName = merchantName
        self.pending = pending
        self.paymentChannel = paymentChannel
        self.categoryPrimary = categoryPrimary
        self.categoryDetailed = categoryDetailed
        self.accountName = accountName
        self.accountMask = accountMask
        self.institution = institution
        self.accountType = accountType
        self.balanceCurrent = balanceCurrent
        self.balanceAvailable = balanceAvailable
    }

    /// True for an inflow / refund (negative amount, Plaid convention).
    public var isInflow: Bool { amount < 0 }
}

/// `HealthBody` — family #4 (HealthKit-derived signals only — never raw samples).
public struct HealthBody: Equatable, Hashable, Sendable, Decodable {
    public var metricType: String   // e.g. "resting_heart_rate", "hrv_sdnn"
    public var value: Double
    public var unit: String         // "bpm", "ms", "hr", ...
    public var sourceDevice: String?
    public var periodStart: Date?
    public var periodEnd: Date?
    public var min: Double?
    public var max: Double?
    public var avg: Double?
    public var anomalyReason: String?

    enum CodingKeys: String, CodingKey {
        case metricType, metric_type
        case value
        case unit
        case sourceDevice, source_device
        case periodStart, period_start
        case periodEnd, period_end
        case min
        case max
        case avg
        case anomalyReason, anomaly_reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.metricType = WireDecode.string(c, .metricType, .metric_type) ?? ""
        self.value = WireDecode.double(c, .value) ?? 0
        self.unit = WireDecode.string(c, .unit) ?? ""
        self.sourceDevice = WireDecode.nonEmpty(c, .sourceDevice, .source_device)
        self.periodStart = WireDecode.date(c, .periodStart, .period_start)
        self.periodEnd = WireDecode.date(c, .periodEnd, .period_end)
        self.min = WireDecode.double(c, .min)
        self.max = WireDecode.double(c, .max)
        self.avg = WireDecode.double(c, .avg)
        self.anomalyReason = WireDecode.nonEmpty(c, .anomalyReason, .anomaly_reason)
    }

    public init(
        metricType: String,
        value: Double,
        unit: String,
        sourceDevice: String? = nil,
        periodStart: Date? = nil,
        periodEnd: Date? = nil,
        min: Double? = nil,
        max: Double? = nil,
        avg: Double? = nil,
        anomalyReason: String? = nil
    ) {
        self.metricType = metricType
        self.value = value
        self.unit = unit
        self.sourceDevice = sourceDevice
        self.periodStart = periodStart
        self.periodEnd = periodEnd
        self.min = min
        self.max = max
        self.avg = avg
        self.anomalyReason = anomalyReason
    }

    /// An anomaly was flagged on this metric (drives the "needs attention" rail).
    public var isAnomalous: Bool { !(anomalyReason ?? "").isEmpty }
}

/// `SessionBody` — family #2 (claude-code sessions from Nexus).
public struct SessionBody: Equatable, Hashable, Sendable, Decodable {
    public var status: String          // running | idle | ended
    public var agentState: String?     // ready | blocked | waiting
    public var sessionType: String?    // ad_hoc | apply
    public var machine: String?
    public var model: String?
    public var branch: String?
    public var totalCostUsd: Double?
    public var rateLimitUtilization: Double?
    public var spec: String?

    enum CodingKeys: String, CodingKey {
        case status
        case agentState, agent_state
        case sessionType, session_type
        case machine
        case model
        case branch
        case totalCostUsd, total_cost_usd
        case rateLimitUtilization, rate_limit_utilization
        case spec
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.status = WireDecode.string(c, .status) ?? "idle"
        self.agentState = WireDecode.nonEmpty(c, .agentState, .agent_state)
        self.sessionType = WireDecode.nonEmpty(c, .sessionType, .session_type)
        self.machine = WireDecode.nonEmpty(c, .machine)
        self.model = WireDecode.nonEmpty(c, .model)
        self.branch = WireDecode.nonEmpty(c, .branch)
        self.totalCostUsd = WireDecode.double(c, .totalCostUsd, .total_cost_usd)
        self.rateLimitUtilization = WireDecode.double(c, .rateLimitUtilization, .rate_limit_utilization)
        self.spec = WireDecode.nonEmpty(c, .spec)
    }

    public init(
        status: String,
        agentState: String? = nil,
        sessionType: String? = nil,
        machine: String? = nil,
        model: String? = nil,
        branch: String? = nil,
        totalCostUsd: Double? = nil,
        rateLimitUtilization: Double? = nil,
        spec: String? = nil
    ) {
        self.status = status
        self.agentState = agentState
        self.sessionType = sessionType
        self.machine = machine
        self.model = model
        self.branch = branch
        self.totalCostUsd = totalCostUsd
        self.rateLimitUtilization = rateLimitUtilization
        self.spec = spec
    }
}

/// `MedicationBody` — family #6 (src-meds, mx-t66o). The gRPC source emits
/// `Kind=MEDICATION` carrying a served dose/adherence signal. Read-only here;
/// the CRUD round-trips through the meds sidecar (NexusClient+Meds), NOT triage.
public struct MedicationBody: Equatable, Hashable, Sendable, Decodable {
    public var medicationName: String
    public var group: String?
    public var status: String          // taken | skipped | missed
    public var scheduledTime: Date?
    public var loggedTime: Date?
    public var dose: String?
    public var unit: String?

    enum CodingKeys: String, CodingKey {
        case medicationName, medication_name
        case group
        case status
        case scheduledTime, scheduled_time
        case loggedTime, logged_time
        case dose, unit
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.medicationName = WireDecode.string(c, .medicationName, .medication_name) ?? ""
        self.group = WireDecode.nonEmpty(c, .group)
        self.status = WireDecode.string(c, .status) ?? "taken"
        self.scheduledTime = WireDecode.date(c, .scheduledTime, .scheduled_time)
        self.loggedTime = WireDecode.date(c, .loggedTime, .logged_time)
        self.dose = WireDecode.nonEmpty(c, .dose)
        self.unit = WireDecode.nonEmpty(c, .unit)
    }

    public init(
        medicationName: String,
        group: String? = nil,
        status: String,
        scheduledTime: Date? = nil,
        loggedTime: Date? = nil,
        dose: String? = nil,
        unit: String? = nil
    ) {
        self.medicationName = medicationName
        self.group = group
        self.status = status
        self.scheduledTime = scheduledTime
        self.loggedTime = loggedTime
        self.dose = dose
        self.unit = unit
    }

    public var isMissed: Bool { status.lowercased() == "missed" }
}

// MARK: - Payload oneof

/// `TriagePayload` — the per-family body oneof. Exactly one arm is set, keyed by
/// `Core.kind`. `.unknown` is the neutral fallback so decode never throws on an
/// unrecognised kind / missing payload (proto3 forward-compat in Swift).
public enum TriagePayload: Equatable, Hashable, Sendable {
    case comms(CommsBody)
    case calendar(CalendarBody)
    case finance(FinanceBody)
    case health(HealthBody)
    case session(SessionBody)
    case medication(MedicationBody)
    case unknown

    /// Decode the payload from a `payload` container, preferring an explicit
    /// oneof arm key (protojson: `payload.comms`, `.sessions`, `.finance`,
    /// `.health`, `.calendar`) and falling back to `kind` when the body is
    /// flattened or the arm key is absent.
    static func decode(
        from decoder: Decoder,
        kind: TriageKind
    ) -> TriagePayload {
        // 1) Explicit oneof arm under a `payload` object (protojson shape).
        if let c = try? decoder.container(keyedBy: PayloadCodingKeys.self),
           let nested = try? c.nestedContainer(keyedBy: ArmCodingKeys.self, forKey: .payload) {
            if let b = try? nested.decode(CommsBody.self, forKey: .comms) { return .comms(b) }
            if let b = try? nested.decode(SessionBody.self, forKey: .sessions) { return .session(b) }
            if let b = try? nested.decode(FinanceBody.self, forKey: .finance) { return .finance(b) }
            if let b = try? nested.decode(HealthBody.self, forKey: .health) { return .health(b) }
            if let b = try? nested.decode(CalendarBody.self, forKey: .calendar) { return .calendar(b) }
            if let b = try? nested.decode(MedicationBody.self, forKey: .medication) { return .medication(b) }
        }
        // 2) Flattened / kind-keyed: decode the body straight off the item
        //    container, choosing the arm by Core.kind.
        return decodeByKind(from: decoder, kind: kind)
    }

    private static func decodeByKind(from decoder: Decoder, kind: TriageKind) -> TriagePayload {
        switch kind {
        case .email, .chatMessage, .ticket, .workItem, .codeReview:
            if let b = try? CommsBody(from: decoder) { return .comms(b) }
        case .calendarEvent:
            if let b = try? CalendarBody(from: decoder) { return .calendar(b) }
        case .financeTxn:
            if let b = try? FinanceBody(from: decoder) { return .finance(b) }
        case .healthMetric:
            if let b = try? HealthBody(from: decoder) { return .health(b) }
        case .codeSession:
            if let b = try? SessionBody(from: decoder) { return .session(b) }
        case .medication:
            if let b = try? MedicationBody(from: decoder) { return .medication(b) }
        case .note, .media, .observability, .unknown:
            break
        }
        return .unknown
    }

    private enum PayloadCodingKeys: String, CodingKey { case payload }
    private enum ArmCodingKeys: String, CodingKey {
        case comms, sessions, finance, health, calendar, medication
    }

    // Convenience accessors for the views.
    public var comms: CommsBody?       { if case .comms(let b) = self { return b }; return nil }
    public var calendar: CalendarBody? { if case .calendar(let b) = self { return b }; return nil }
    public var finance: FinanceBody?   { if case .finance(let b) = self { return b }; return nil }
    public var health: HealthBody?     { if case .health(let b) = self { return b }; return nil }
    public var session: SessionBody?   { if case .session(let b) = self { return b }; return nil }
    public var medication: MedicationBody? { if case .medication(let b) = self { return b }; return nil }
}

// MARK: - Verdict (decide-flow LLM triage verdict)

/// The mx LLM triage verdict attached to a queue item (add-triage-verdict-layer,
/// mx-3z8y). A sibling of `core` / `payload` on the wire (`item.verdict`). EVERY
/// field is optional and the whole struct is nested-optional on `TriageItem`, so
/// a pre-verdict gateway payload (no `verdict` key) decodes UNCHANGED — the
/// decide surface renders such an item as skip-only (no VerdictBox, excluded from
/// forced-decision). Decodes camelCase OR snake_case per the WireDecode
/// convention; `confidence` accepts a numeric score (0…1) OR a band string.
///
/// Spec: openspec/changes/add-decide-flow-menubar (NexusShared task 2.1).
public struct Verdict: Equatable, Hashable, Sendable, Codable {
    /// The recommended narrow action (defer / delegate / preempt / group /
    /// resolve / snooze). Drives the primary accept path + the VerdictBox label.
    public var action: String?
    /// The suggested disposition (mirrors CommsDisposition semantics, but a raw
    /// string here — the verdict layer is source-agnostic).
    public var disposition: String?
    /// One-line rationale the model produced ("why this action").
    public var reason: String?
    /// Confidence score in 0…1 when numeric. A band string ("high"/"medium"/
    /// "low") on the wire decodes to nil here and is surfaced via `confidenceBand`.
    public var confidence: Double?
    /// Confidence band as sent by the gateway when it emits a string instead of
    /// a score. `confidenceBand` prefers the numeric score, falling back to this.
    public var confidenceLabel: String?
    /// The prompt template version that produced this verdict (pilot bookkeeping).
    public var promptVersion: String?
    /// Stable verdict id — REQUIRED to post a decision. An item with no
    /// `verdictId` cannot be decided (render skip-only).
    public var verdictId: String?

    enum CodingKeys: String, CodingKey {
        case action
        case disposition
        case reason
        case confidence
        case confidenceLabel, confidence_label, confidenceBand, confidence_band
        case promptVersion, prompt_version
        case verdictId, verdict_id
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.action = WireDecode.nonEmpty(c, .action)
        self.disposition = WireDecode.nonEmpty(c, .disposition)
        self.reason = WireDecode.nonEmpty(c, .reason)
        // Numeric score preferred; a band STRING under `confidence` folds into
        // confidenceLabel so a `"confidence": "high"` payload still renders.
        self.confidence = WireDecode.double(c, .confidence)
        let bandFromConfidence = self.confidence == nil
            ? WireDecode.nonEmpty(c, .confidence) : nil
        self.confidenceLabel = WireDecode.nonEmpty(
            c, .confidenceLabel, .confidence_label, .confidenceBand, .confidence_band
        ) ?? bandFromConfidence
        self.promptVersion = WireDecode.nonEmpty(c, .promptVersion, .prompt_version)
        self.verdictId = WireDecode.nonEmpty(c, .verdictId, .verdict_id)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(action, forKey: .action)
        try c.encodeIfPresent(disposition, forKey: .disposition)
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encodeIfPresent(confidence, forKey: .confidence)
        try c.encodeIfPresent(confidenceLabel, forKey: .confidenceLabel)
        try c.encodeIfPresent(promptVersion, forKey: .promptVersion)
        try c.encodeIfPresent(verdictId, forKey: .verdictId)
    }

    public init(
        action: String? = nil,
        disposition: String? = nil,
        reason: String? = nil,
        confidence: Double? = nil,
        confidenceLabel: String? = nil,
        promptVersion: String? = nil,
        verdictId: String? = nil
    ) {
        self.action = action
        self.disposition = disposition
        self.reason = reason
        self.confidence = confidence
        self.confidenceLabel = confidenceLabel
        self.promptVersion = promptVersion
        self.verdictId = verdictId
    }

    /// Banded confidence label the VerdictBox renders. Prefers the numeric
    /// score (>=0.75 high, >=0.4 medium, else low); falls back to the raw
    /// `confidenceLabel` string; nil when neither is present.
    public var confidenceBand: String? {
        if let c = confidence {
            if c >= 0.75 { return "high" }
            if c >= 0.40 { return "medium" }
            return "low"
        }
        return confidenceLabel?.lowercased()
    }

    /// A verdict is actionable (a decision can be posted) only when it carries a
    /// `verdictId`. Verdict-less / id-less items are skip-only.
    public var isActionable: Bool {
        !(verdictId ?? "").isEmpty
    }
}

// MARK: - Triage ledger (viewer decision overlay)

/// A single freeform comment on a ledger row (`comments` JSONB element). Wire
/// keys are already `ts`/`text`, so synthesized decoding suffices.
public struct LedgerComment: Equatable, Hashable, Sendable, Decodable {
    public let ts: String
    public let text: String
    public init(ts: String, text: String) {
        self.ts = ts
        self.text = text
    }
}

/// The viewer's persisted triage decision for an item, spliced onto `/triage`
/// as the `triage` key (sibling of `verdict`) and returned by the two
/// triage-ledger POST routes. Mirrors the gateway `ledgerJSON` wire shape
/// (mx triage-ledger design §2/§4) field-for-field. OMITTED by the gateway
/// when no ledger row exists yet, so `TriageItem.triage` is nil-tolerant — an
/// un-triaged item decodes UNCHANGED, exactly like a pre-verdict payload.
///
/// Decodes camelCase OR snake_case per the WireDecode convention; the two
/// timestamps accept ISO8601 (fractional / plain) or numeric epoch.
public struct LedgerEntry: Identifiable, Equatable, Hashable, Sendable, Decodable {
    /// `Core.id` this row keys off (e.g. "ado:wi:31482").
    public var id: String
    /// Denormalized source, for filtering.
    public var source: String
    /// One of INBOX | OPEN | WAITING | RESOLVED | ARCHIVED.
    public var status: String
    /// The viewer manually overrode the suggested disposition.
    public var manual: Bool
    /// When `status` was last set.
    public var statusSetAt: Date?
    /// Non-nil + future => item is snoozed until this instant.
    public var snoozedUntil: Date?
    /// Freeform close note.
    public var resolution: String?
    /// Promoted-to-beads link, when the item was turned into a bd issue.
    public var bdId: String?
    /// The INBOX-vs-keep call has been made.
    public var triaged: Bool
    /// Freeform comments, oldest-first as stored.
    public var comments: [LedgerComment]

    enum CodingKeys: String, CodingKey {
        case id, source, status, manual
        case statusSetAt, status_set_at
        case snoozedUntil, snoozed_until
        case resolution
        case bdId, bd_id
        case triaged
        case comments
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = WireDecode.string(c, .id) ?? ""
        self.source = WireDecode.string(c, .source) ?? ""
        self.status = WireDecode.string(c, .status) ?? "INBOX"
        self.manual = WireDecode.bool(c, .manual)
        self.statusSetAt = WireDecode.date(c, .statusSetAt, .status_set_at)
        self.snoozedUntil = WireDecode.date(c, .snoozedUntil, .snoozed_until)
        self.resolution = WireDecode.nonEmpty(c, .resolution)
        self.bdId = WireDecode.nonEmpty(c, .bdId, .bd_id)
        self.triaged = WireDecode.bool(c, .triaged)
        self.comments = (try? c.decode([LedgerComment].self, forKey: .comments)) ?? []
    }

    public init(
        id: String,
        source: String,
        status: String,
        manual: Bool = false,
        statusSetAt: Date? = nil,
        snoozedUntil: Date? = nil,
        resolution: String? = nil,
        bdId: String? = nil,
        triaged: Bool = false,
        comments: [LedgerComment] = []
    ) {
        self.id = id
        self.source = source
        self.status = status
        self.manual = manual
        self.statusSetAt = statusSetAt
        self.snoozedUntil = snoozedUntil
        self.resolution = resolution
        self.bdId = bdId
        self.triaged = triaged
        self.comments = comments
    }

    /// Uppercased status token, normalized for switch/match
    /// (INBOX | OPEN | WAITING | RESOLVED | ARCHIVED).
    public var statusUpper: String { status.uppercased() }

    /// A snooze that is set AND still in the future — the overlay's
    /// "snoozed until <date>" indicator keys off this.
    public var isSnoozeActive: Bool {
        guard let until = snoozedUntil else { return false }
        return until > Date()
    }
}

// MARK: - TriageItem (Core spine + payload)

/// The unified item every archetype page renders: the `Core` correlation spine
/// (present on EVERY item) plus the per-family `TriagePayload`.
public struct TriageItem: Identifiable, Equatable, Hashable, Sendable, Decodable {
    // --- Core spine ---
    public var id: String
    public var source: String
    public var kind: TriageKind
    public var threadKey: String?
    public var title: String
    public var url: String?
    public var author: IdentityRef?
    public var participants: [IdentityRef]
    public var ballInCourt: BallInCourt
    public var createdAt: Date?
    public var lastActivityAt: Date?
    public var stillPresentUpstream: Bool
    public var lastSeenAt: Date?
    // --- Family body ---
    public var payload: TriagePayload
    // --- Decide-flow LLM verdict (optional; sibling of core/payload) ---
    /// The mx triage verdict, when present. Nil for a pre-verdict payload — the
    /// decide surface renders such items skip-only. Additive: absence NEVER
    /// changes how the rest of the item decodes.
    public var verdict: Verdict?
    // --- Viewer triage-ledger decision (optional; sibling of verdict) ---
    /// The viewer's persisted ledger decision (status / snooze / resolution),
    /// spliced onto the item as the `triage` key. Nil when no ledger row exists
    /// (the gateway OMITS the key), same nil-tolerance as `verdict`. Additive:
    /// absence never changes how the rest of the item decodes.
    public var triage: LedgerEntry?

    /// Item-level coding keys: both the nested-`core` (protojson) shape and the
    /// flattened shape resolve through `init(from:)` below, which probes for a
    /// `core` object first and falls back to top-level keys. `verdict` and
    /// `triage` are top-level siblings in BOTH shapes.
    private enum TopKeys: String, CodingKey { case core, payload, verdict, triage }
    private enum CoreKeys: String, CodingKey {
        case id, source, kind, title, url, author, participants
        case threadKey, thread_key
        case ballInCourt, ball_in_court
        case createdAt, created_at
        case lastActivityAt, last_activity_at
        case stillPresentUpstream, still_present_upstream
        case lastSeenAt, last_seen_at
    }

    public init(from decoder: Decoder) throws {
        // Resolve the Core container: nested `core` object (protojson) OR the
        // top-level item itself (flattened). Both decode through CoreKeys.
        let top = try? decoder.container(keyedBy: TopKeys.self)
        let core: KeyedDecodingContainer<CoreKeys>
        if let top, let nested = try? top.nestedContainer(keyedBy: CoreKeys.self, forKey: .core) {
            core = nested
        } else {
            core = try decoder.container(keyedBy: CoreKeys.self)
        }

        self.id = WireDecode.string(core, .id) ?? UUID().uuidString
        self.source = WireDecode.string(core, .source) ?? ""
        self.kind = TriageKind(wire: WireDecode.string(core, .kind))
        self.threadKey = WireDecode.nonEmpty(core, .threadKey, .thread_key)
        self.title = WireDecode.string(core, .title) ?? ""
        self.url = WireDecode.nonEmpty(core, .url)
        self.author = try? core.decode(IdentityRef.self, forKey: .author)
        self.participants = (try? core.decode([IdentityRef].self, forKey: .participants)) ?? []
        self.ballInCourt = BallInCourt(wire: WireDecode.string(core, .ballInCourt, .ball_in_court))
        self.createdAt = WireDecode.date(core, .createdAt, .created_at)
        self.lastActivityAt = WireDecode.date(core, .lastActivityAt, .last_activity_at)
        self.stillPresentUpstream = WireDecode.bool(core, .stillPresentUpstream, .still_present_upstream, default: true)
        self.lastSeenAt = WireDecode.date(core, .lastSeenAt, .last_seen_at)

        self.payload = TriagePayload.decode(from: decoder, kind: self.kind)
        // `verdict` sits at the top level in both the nested-`core` and the
        // flattened shapes (`top` is keyed off the same container). Absent key
        // -> nil, which is the pre-verdict steady state.
        if let top, let decoded = try? top.decodeIfPresent(Verdict.self, forKey: .verdict) {
            self.verdict = decoded
        } else {
            self.verdict = nil
        }
        // `triage` is the viewer-decision overlay, a top-level sibling of
        // `verdict`. Absent key -> nil (the un-triaged steady state).
        if let top, let decoded = try? top.decodeIfPresent(LedgerEntry.self, forKey: .triage) {
            self.triage = decoded
        } else {
            self.triage = nil
        }
    }

    public init(
        id: String,
        source: String,
        kind: TriageKind,
        threadKey: String? = nil,
        title: String,
        url: String? = nil,
        author: IdentityRef? = nil,
        participants: [IdentityRef] = [],
        ballInCourt: BallInCourt = .unclear,
        createdAt: Date? = nil,
        lastActivityAt: Date? = nil,
        stillPresentUpstream: Bool = true,
        lastSeenAt: Date? = nil,
        payload: TriagePayload,
        verdict: Verdict? = nil,
        triage: LedgerEntry? = nil
    ) {
        self.id = id
        self.source = source
        self.kind = kind
        self.threadKey = threadKey
        self.title = title
        self.url = url
        self.author = author
        self.participants = participants
        self.ballInCourt = ballInCourt
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt
        self.stillPresentUpstream = stillPresentUpstream
        self.lastSeenAt = lastSeenAt
        self.payload = payload
        self.verdict = verdict
        self.triage = triage
    }
}
